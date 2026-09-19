#include "native_canvas/scene_kernel.h"

#include <chrono>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <vector>

int main() {
  using namespace native_canvas;
  constexpr std::size_t kItemCount = 3'200;
  SceneLimits limits;
  limits.max_items = kItemCount;
  limits.max_selection = 512;
  limits.overscan_pixels = 64.0;
  SceneKernel kernel(limits);

  std::vector<ItemTransformDelta> items;
  items.reserve(kItemCount);
  for (std::size_t i = 0; i < kItemCount; ++i) {
    const double x = static_cast<double>((i * 37) % 16000) - 8000.0;
    const double y = static_cast<double>((i * 91) % 12000) - 6000.0;
    items.push_back(ItemTransformDelta{static_cast<ItemId>(i + 1), x, y,
                                       24.0 + static_cast<double>(i % 17),
                                       18.0 + static_cast<double>(i % 11),
                                       (i % 9 == 0) ? -1.0 : 1.0,
                                       1.0 + static_cast<double>(i % 5) * 0.1,
                                       static_cast<double>(i % 13) * 0.1});
  }
  const auto add = kernel.AddItems(items);
  if (!add) {
    std::cerr << "AddItems failed: " << ErrorCodeName(add.code) << " " << add.message << '\n';
    return 1;
  }
  std::vector<ItemId> selection;
  for (ItemId id = 1; id <= 512; id += 3) selection.push_back(id);
  const auto select = kernel.UpdateSelection(selection);
  if (!select) return 1;
  const auto viewport = kernel.SetViewport(ViewportUpdate{-1600.0, -1200.0, 0.75, 1600, 900, 1.0});
  if (!viewport) return 1;

  constexpr int kIterations = 400;
  std::uint64_t checksum = 0;
  std::size_t last_visible = 0;
  const auto start = std::chrono::steady_clock::now();
  for (int i = 0; i < kIterations; ++i) {
    auto result = kernel.QueryVisible();
    last_visible = result.visible_ids.size();
    for (const auto id : result.visible_ids) checksum = checksum * 1315423911ULL + id;
  }
  const auto elapsed = std::chrono::steady_clock::now() - start;
  const double total_ms = std::chrono::duration<double, std::milli>(elapsed).count();

  std::cout << "native-canvas diagnostic benchmark (CPU-only headless scene query; not Canvas/GPU)\n"
            << "scene_count=" << kernel.item_count() << "\n"
            << "visible_result=" << last_visible << "\n"
            << "iterations=" << kIterations << "\n"
            << "checksum=" << checksum << "\n"
            << std::fixed << std::setprecision(3)
            << "total_query_ms=" << total_ms << "\n"
            << "mean_query_ms=" << total_ms / kIterations << "\n";
  return 0;
}
