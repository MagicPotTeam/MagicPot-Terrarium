#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace native_canvas {

using ItemId = std::uint64_t;

struct ViewportUpdate {
  double x = 0.0;
  double y = 0.0;
  double scale = 1.0;
  std::uint32_t width = 1;
  std::uint32_t height = 1;
  double device_scale = 1.0;
};

// x/y are the item's local-space center. Width and height are non-negative
// local dimensions; signed scales and arbitrary finite rotation are allowed.
struct ItemTransformDelta {
  ItemId id = 0;
  double x = 0.0;
  double y = 0.0;
  double width = 0.0;
  double height = 0.0;
  double scale_x = 1.0;
  double scale_y = 1.0;
  double rotation = 0.0;
};

struct InteractionState {
  bool pointer_down = false;
  bool panning = false;
  bool dragging = false;
};

enum class ErrorCode {
  kOk,
  kInvalidArgument,
  kNonFinite,
  kOverflow,
  kCapacityExceeded,
  kDuplicateId,
  kNotFound,
  kInternal,
};

struct ApplyResult {
  ErrorCode code = ErrorCode::kOk;
  std::string message;

  [[nodiscard]] bool ok() const noexcept { return code == ErrorCode::kOk; }
  explicit operator bool() const noexcept { return ok(); }
};

struct SceneLimits {
  std::size_t max_items = 10'000;
  std::size_t max_selection = 10'000;
  double cell_size = 256.0;
  double overscan_pixels = 128.0;
  std::size_t max_cells_per_item = 1'024;
};

struct QueryResult {
  std::vector<ItemId> visible_ids;
  // The complete selection and the visible part of the selection are both
  // ordered by ItemId, independent of insertion or update order.
  std::vector<ItemId> selected_ids;
  std::vector<ItemId> selected_visible_ids;
  std::uint64_t scene_revision = 0;
  bool used_full_scan = false;
};

struct Rect {
  double min_x = 0.0;
  double min_y = 0.0;
  double max_x = 0.0;
  double max_y = 0.0;
};

[[nodiscard]] std::optional<Rect> ComputeConservativeAabb(
    const ItemTransformDelta& item);
[[nodiscard]] const char* ErrorCodeName(ErrorCode code) noexcept;

class SceneKernel final {
 public:
  explicit SceneKernel(SceneLimits limits = {});
  ~SceneKernel();

  SceneKernel(SceneKernel&&) noexcept;
  SceneKernel& operator=(SceneKernel&&) noexcept;
  SceneKernel(const SceneKernel&) = delete;
  SceneKernel& operator=(const SceneKernel&) = delete;

  // Each call validates the complete input before changing the scene. A
  // rejected call therefore does not apply a prefix of a delta.
  [[nodiscard]] ApplyResult AddItems(
      std::span<const ItemTransformDelta> items);
  [[nodiscard]] ApplyResult RemoveItems(std::span<const ItemId> ids);
  [[nodiscard]] ApplyResult UpdateTransforms(
      std::span<const ItemTransformDelta> items);
  [[nodiscard]] ApplyResult UpdateSelection(std::span<const ItemId> ids);
  [[nodiscard]] ApplyResult SetViewport(const ViewportUpdate& viewport);
  [[nodiscard]] ApplyResult SetInteractionState(
      const InteractionState& state);

  [[nodiscard]] QueryResult QueryVisible() const;
  [[nodiscard]] std::size_t item_count() const noexcept;
  [[nodiscard]] std::uint64_t scene_revision() const noexcept;
  [[nodiscard]] std::vector<ItemId> selected_ids() const;
  [[nodiscard]] std::optional<Rect> CachedBounds(ItemId id) const;

  // Expensive diagnostic invariant check used by the geometry tests. It does
  // not rebuild or mutate the working set.
  [[nodiscard]] bool Validate(std::string* error = nullptr) const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace native_canvas
