// Private synthetic-PNG experiment. No filename, URL, IPC, or production hook.
// WIC owns its internal decoder/cache allocations; this program never materializes
// a full-resolution RGBA buffer. The measured process peak includes WIC internals.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define PSAPI_VERSION 1
#include <windows.h>
#include <wincodec.h>
#include <psapi.h>
#include <io.h>
#include <fcntl.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <limits>
#include <new>
#include <utility>
#include <vector>

namespace {
constexpr size_t kMaxInput = 20u * 1024u * 1024u;
constexpr uint64_t kMaxPixels = 40'000'000;
constexpr size_t kMaxOutput = 2u * 1024u * 1024u;
struct Failure { const char* code; HRESULT hr; };
[[noreturn]] void fail(const char* code, HRESULT hr = E_FAIL) { throw Failure{code, hr}; }
void check(HRESULT hr, const char* code) { if (FAILED(hr)) fail(code, hr); }

template<class T> class ComPtr {
 public:
  ComPtr() = default;
  explicit ComPtr(T* value) : value_(value) {}
  ~ComPtr() { if (value_) value_->Release(); }
  ComPtr(const ComPtr&) = delete;
  ComPtr& operator=(const ComPtr&) = delete;
  T* get() const { return value_; }
  T* operator->() const { return value_; }
  T** put() { return &value_; } // Only used once for each initially empty pointer.
 private:
  T* value_ = nullptr;
};
class ComApartment {
 public:
  ComApartment() { check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM_INIT_FAILED"); }
  ~ComApartment() { CoUninitialize(); }
  ComApartment(const ComApartment&) = delete;
  ComApartment& operator=(const ComApartment&) = delete;
};

// A seekable output stream with a hard allocation/output bound. WIC's PNG encoder
// cannot spill into a file or grow a global-memory stream beyond the limit.
class BoundedStream final : public IStream {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    *value = nullptr;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(ISequentialStream) || iid == __uuidof(IStream)) {
      *value = static_cast<IStream*>(this); AddRef(); return S_OK;
    }
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&refs_)); }
  ULONG STDMETHODCALLTYPE Release() override {
    const LONG refs = InterlockedDecrement(&refs_);
    if (!refs) delete this;
    return static_cast<ULONG>(refs);
  }
  HRESULT STDMETHODCALLTYPE Read(void* data, ULONG count, ULONG* read) override {
    if (read) *read = 0;
    if (!data && count) return STG_E_INVALIDPOINTER;
    const size_t available = position_ < bytes_.size() ? bytes_.size() - position_ : 0;
    const size_t actual = (std::min)(static_cast<size_t>(count), available);
    if (actual) std::memcpy(data, bytes_.data() + position_, actual);
    position_ += actual;
    if (read) *read = static_cast<ULONG>(actual);
    return actual == count ? S_OK : S_FALSE;
  }
  HRESULT STDMETHODCALLTYPE Write(const void* data, ULONG count, ULONG* written) override {
    if (written) *written = 0;
    if (!data && count) return STG_E_INVALIDPOINTER;
    if (count > kMaxOutput - position_) { exceeded_ = true; return STG_E_MEDIUMFULL; }
    const size_t end = position_ + count;
    try {
      if (end > bytes_.capacity()) bytes_.reserve(kMaxOutput);
      if (end > bytes_.size()) bytes_.resize(end);
    } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
    if (count) std::memcpy(bytes_.data() + position_, data, count);
    position_ = end;
    if (written) *written = count;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER* result) override {
    int64_t base = 0;
    if (origin == STREAM_SEEK_CUR) base = static_cast<int64_t>(position_);
    else if (origin == STREAM_SEEK_END) base = static_cast<int64_t>(bytes_.size());
    else if (origin != STREAM_SEEK_SET) return STG_E_INVALIDFUNCTION;
    if (move.QuadPart < -base || move.QuadPart > static_cast<int64_t>(kMaxOutput) - base)
      return STG_E_INVALIDFUNCTION;
    position_ = static_cast<size_t>(base + move.QuadPart);
    if (result) result->QuadPart = position_;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER size) override {
    if (size.QuadPart > kMaxOutput) { exceeded_ = true; return STG_E_MEDIUMFULL; }
    try {
      if (size.QuadPart > bytes_.capacity()) bytes_.reserve(kMaxOutput);
      bytes_.resize(static_cast<size_t>(size.QuadPart));
    } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream*, ULARGE_INTEGER, ULARGE_INTEGER*, ULARGE_INTEGER*) override {
    return E_NOTIMPL;
  }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override {
    return STG_E_INVALIDFUNCTION;
  }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override {
    return STG_E_INVALIDFUNCTION;
  }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG* stat, DWORD) override {
    if (!stat) return E_POINTER;
    std::memset(stat, 0, sizeof(*stat));
    stat->type = STGTY_STREAM; stat->cbSize.QuadPart = bytes_.size(); stat->grfMode = STGM_READWRITE;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream** result) override {
    if (result) *result = nullptr;
    return E_NOTIMPL;
  }
  bool exceeded() const { return exceeded_; }
  std::vector<BYTE> take() { return std::move(bytes_); }
 private:
  ~BoundedStream() = default;
  LONG refs_ = 1;
  size_t position_ = 0;
  bool exceeded_ = false;
  std::vector<BYTE> bytes_;
};

struct Stats {
  uint64_t inputBytes = 0, outputBytes = 0;
  UINT inputWidth = 0, inputHeight = 0, outputWidth = 0, outputHeight = 0, maxEdge = 256;
};
uint32_t be32(const BYTE* data) {
  return (uint32_t(data[0]) << 24) | (uint32_t(data[1]) << 16) |
         (uint32_t(data[2]) << 8) | uint32_t(data[3]);
}
std::vector<BYTE> readInput(Stats& stats) {
  std::vector<BYTE> input;
  std::array<BYTE, 64u * 1024u> chunk{};
  for (;;) {
    const size_t wanted = (std::min)(chunk.size(), kMaxInput + 1 - input.size());
    const size_t count = std::fread(chunk.data(), 1, wanted, stdin);
    stats.inputBytes += count;
    if (input.size() + count > kMaxInput) fail("INPUT_TOO_LARGE");
    input.insert(input.end(), chunk.data(), chunk.data() + count);
    if (count < wanted) {
      if (std::ferror(stdin)) fail("INPUT_READ_FAILED");
      break;
    }
  }
  return input;
}
void preflightPng(const std::vector<BYTE>& input, Stats& stats) {
  constexpr BYTE signature[] = {137, 80, 78, 71, 13, 10, 26, 10};
  if (input.size() < 33 || std::memcmp(input.data(), signature, sizeof(signature)) != 0 ||
      be32(input.data() + 8) != 13 || std::memcmp(input.data() + 12, "IHDR", 4) != 0)
    fail("INVALID_PNG");
  stats.inputWidth = be32(input.data() + 16);
  stats.inputHeight = be32(input.data() + 20);
  if (!stats.inputWidth || !stats.inputHeight ||
      uint64_t(stats.inputWidth) * stats.inputHeight > kMaxPixels)
    fail("DIMENSIONS_LIMIT");
  bool sawData = false, sawEnd = false;
  for (size_t offset = 8; offset < input.size();) {
    if (input.size() - offset < 12) fail("INVALID_PNG_CHUNKS");
    const size_t length = be32(input.data() + offset);
    if (length > input.size() - offset - 12) fail("INVALID_PNG_CHUNKS");
    const BYTE* kind = input.data() + offset + 4;
    if (std::memcmp(kind, "acTL", 4) == 0 || std::memcmp(kind, "fcTL", 4) == 0 ||
        std::memcmp(kind, "fdAT", 4) == 0) fail("ANIMATED_PNG_UNSUPPORTED");
    if (offset != 8 && std::memcmp(kind, "IHDR", 4) == 0) fail("INVALID_PNG_CHUNKS");
    if (std::memcmp(kind, "IDAT", 4) == 0) sawData = true;
    offset += length + 12;
    if (std::memcmp(kind, "IEND", 4) == 0) {
      if (length || offset != input.size()) fail("INVALID_PNG_CHUNKS");
      sawEnd = true; break;
    }
  }
  if (!sawData || !sawEnd) fail("INVALID_PNG_CHUNKS");
}
std::vector<BYTE> makePreview(Stats& stats) {
  auto input = readInput(stats);
  preflightPng(input, stats);
  ComApartment apartment;
  ComPtr<IWICImagingFactory> factory;
  check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                         __uuidof(IWICImagingFactory), reinterpret_cast<void**>(factory.put())),
        "WIC_FACTORY_FAILED");
  ComPtr<IWICStream> sourceStream;
  check(factory->CreateStream(sourceStream.put()), "WIC_INPUT_STREAM_FAILED");
  check(sourceStream->InitializeFromMemory(input.data(), static_cast<DWORD>(input.size())),
        "WIC_INPUT_STREAM_FAILED");
  ComPtr<IWICBitmapDecoder> decoder;
  check(factory->CreateDecoder(GUID_ContainerFormatPng, nullptr, decoder.put()), "WIC_DECODER_FAILED");
  check(decoder->Initialize(sourceStream.get(), WICDecodeMetadataCacheOnDemand), "PNG_DECODE_FAILED");
  UINT frames = 0;
  check(decoder->GetFrameCount(&frames), "PNG_DECODE_FAILED");
  if (frames != 1) fail("MULTIFRAME_UNSUPPORTED");
  ComPtr<IWICBitmapFrameDecode> frame;
  check(decoder->GetFrame(0, frame.put()), "PNG_DECODE_FAILED");
  UINT width = 0, height = 0;
  check(frame->GetSize(&width, &height), "PNG_DECODE_FAILED");
  if (width != stats.inputWidth || height != stats.inputHeight) fail("PNG_DIMENSIONS_MISMATCH");
  const UINT longest = (std::max)(width, height);
  stats.outputWidth = longest <= stats.maxEdge ? width :
    static_cast<UINT>((std::max)(uint64_t(1), uint64_t(width) * stats.maxEdge / longest));
  stats.outputHeight = longest <= stats.maxEdge ? height :
    static_cast<UINT>((std::max)(uint64_t(1), uint64_t(height) * stats.maxEdge / longest));
  if (!stats.outputWidth || !stats.outputHeight || stats.outputWidth > stats.maxEdge ||
      stats.outputHeight > stats.maxEdge ||
      uint64_t(stats.outputWidth) * stats.outputHeight * 4 > kMaxOutput)
    fail("OUTPUT_DIMENSIONS_LIMIT");
  ComPtr<IWICBitmapScaler> scaler;
  check(factory->CreateBitmapScaler(scaler.put()), "WIC_SCALER_FAILED");
  check(scaler->Initialize(frame.get(), stats.outputWidth, stats.outputHeight,
                           WICBitmapInterpolationModeFant), "WIC_SCALE_FAILED");
  // Convert after scaling: no application-owned full-size RGBA conversion.
  ComPtr<IWICFormatConverter> converter;
  check(factory->CreateFormatConverter(converter.put()), "WIC_CONVERTER_FAILED");
  check(converter->Initialize(scaler.get(), GUID_WICPixelFormat32bppBGRA,
                             WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom),
        "WIC_CONVERSION_FAILED");
  ComPtr<BoundedStream> output(new BoundedStream());
  {
    ComPtr<IWICBitmapEncoder> encoder;
    check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()), "WIC_ENCODER_FAILED");
    check(encoder->Initialize(output.get(), WICBitmapEncoderNoCache), "WIC_ENCODER_FAILED");
    ComPtr<IWICBitmapFrameEncode> encodedFrame;
    ComPtr<IPropertyBag2> properties;
    check(encoder->CreateNewFrame(encodedFrame.put(), properties.put()), "WIC_ENCODER_FAILED");
    check(encodedFrame->Initialize(properties.get()), "WIC_ENCODER_FAILED");
    check(encodedFrame->SetSize(stats.outputWidth, stats.outputHeight), "WIC_ENCODER_FAILED");
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    check(encodedFrame->SetPixelFormat(&format), "WIC_ENCODER_FAILED");
    if (format != GUID_WICPixelFormat32bppBGRA) fail("PNG_ALPHA_FORMAT_UNSUPPORTED");
    const HRESULT write = encodedFrame->WriteSource(converter.get(), nullptr);
    if (output->exceeded()) fail("OUTPUT_TOO_LARGE");
    check(write, "PNG_ENCODE_FAILED");
    check(encodedFrame->Commit(), "PNG_ENCODE_FAILED");
    check(encoder->Commit(), "PNG_ENCODE_FAILED");
  }
  auto bytes = output->take();
  if (bytes.empty() || bytes.size() > kMaxOutput) fail("OUTPUT_TOO_LARGE");
  stats.outputBytes = bytes.size();
  return bytes;
}

void report(const Stats& stats, bool ok, const char* error, HRESULT hr, double elapsedMs) {
  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  const BOOL haveMemory = GetProcessMemoryInfo(
    GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory));
  // PeakPagefileUsage is the Windows peak commit-charge field; PrivateUsage is
  // current private commit. These are process metrics, never renderer metrics.
  std::fprintf(stderr,
    "{\"ok\":%s,\"error\":\"%s\",\"hresult\":\"0x%08lX\","
    "\"input_bytes\":%llu,\"input_width\":%u,\"input_height\":%u,"
    "\"output_bytes\":%llu,\"output_width\":%u,\"output_height\":%u,"
    "\"max_edge\":%u,\"elapsed_ms\":%.3f,\"memory_unit\":\"bytes\","
    "\"memory_available\":%s,\"peak_working_set_bytes\":%llu,"
    "\"peak_commit_bytes\":%llu,\"end_private_bytes\":%llu}\n",
    ok ? "true" : "false", error, static_cast<unsigned long>(hr),
    static_cast<unsigned long long>(stats.inputBytes), stats.inputWidth, stats.inputHeight,
    static_cast<unsigned long long>(stats.outputBytes), stats.outputWidth, stats.outputHeight,
    stats.maxEdge, elapsedMs, haveMemory ? "true" : "false",
    static_cast<unsigned long long>(memory.PeakWorkingSetSize),
    static_cast<unsigned long long>(memory.PeakPagefileUsage),
    static_cast<unsigned long long>(memory.PrivateUsage));
}
} // namespace

int main(int argc, char** argv) {
  const auto started = std::chrono::steady_clock::now();
  Stats stats;
  bool ok = false;
  const char* error = "";
  HRESULT hr = S_OK;
  try {
    if (argc == 3 && std::strcmp(argv[1], "--max-edge") == 0 &&
        (std::strcmp(argv[2], "256") == 0 || std::strcmp(argv[2], "512") == 0)) {
      stats.maxEdge = std::strcmp(argv[2], "512") == 0 ? 512u : 256u;
    } else if (argc != 1) fail("INVALID_ARGUMENT");
    if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
        _setmode(_fileno(stdout), _O_BINARY) == -1) fail("BINARY_STDIO_FAILED");
    {
      auto encoded = makePreview(stats);
      // Validation/encoding failures have emitted no stdout. A successful image
      // is published only after encoding/Commit and all size checks complete.
      if (std::fwrite(encoded.data(), 1, encoded.size(), stdout) != encoded.size() ||
          std::fflush(stdout) != 0) fail("OUTPUT_WRITE_FAILED");
    }
    ok = true;
  } catch (const Failure& failure) { error = failure.code; hr = failure.hr; }
    catch (const std::bad_alloc&) { error = "ALLOCATION_FAILED"; hr = E_OUTOFMEMORY; }
    catch (...) { error = "UNEXPECTED_FAILURE"; hr = E_FAIL; }
  const double elapsedMs = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - started).count();
  report(stats, ok, error, hr, elapsedMs);
  return ok ? 0 : 1;
}
