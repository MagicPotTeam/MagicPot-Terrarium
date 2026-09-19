#include "native_canvas/scene_kernel.h"

#include <cassert>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <vector>

using native_canvas::ErrorCode;
using native_canvas::ItemId;
using native_canvas::ItemTransformDelta;
using native_canvas::SceneKernel;
using native_canvas::SceneLimits;
using native_canvas::ViewportUpdate;

namespace {

void expect_ok(const native_canvas::ApplyResult& result) {
  if (!result.ok()) {
    std::cerr << "unexpected " << native_canvas::ErrorCodeName(result.code) << ": " << result.message << '\n';
    std::abort();
  }
}
void expect_code(const native_canvas::ApplyResult& result, ErrorCode code) {
  assert(result.code == code);
}
ItemTransformDelta item(ItemId id, double x, double y, double width, double height,
                        double sx = 1.0, double sy = 1.0, double rotation = 0.0) {
  return ItemTransformDelta{id, x, y, width, height, sx, sy, rotation};
}
void expect_ids(const std::vector<ItemId>& actual, std::initializer_list<ItemId> expected) {
  assert(actual == std::vector<ItemId>(expected));
}

void test_rotated_negative_scale_aabb() {
  const auto bounds = native_canvas::ComputeConservativeAabb(item(1, 10, -3, 8, 4, -2, 3, 3.141592653589793 / 2.0));
  assert(bounds.has_value());
  assert(std::abs(bounds->min_x - 4.0) < 1e-9);
  assert(std::abs(bounds->max_x - 16.0) < 1e-9);
  assert(std::abs(bounds->min_y + 7.0) < 1e-9);
  assert(std::abs(bounds->max_y - 1.0) < 1e-9);
}

void test_deltas_replacement_removal_and_order() {
  SceneLimits limits;
  limits.max_items = 4;
  limits.max_selection = 4;
  limits.overscan_pixels = 0.0;
  SceneKernel kernel(limits);
  expect_ok(kernel.SetViewport(ViewportUpdate{0, 0, 1, 100, 100, 1}));
  const std::vector<ItemTransformDelta> initial{item(3, 30, 20, 10, 10), item(1, 10, 20, 10, 10), item(2, 200, 20, 10, 10)};
  expect_ok(kernel.AddItems(initial));
  expect_ok(kernel.UpdateSelection(std::vector<ItemId>{3, 1}));
  auto query = kernel.QueryVisible();
  expect_ids(query.visible_ids, {1, 3});
  expect_ids(query.selected_ids, {1, 3});
  expect_ids(query.selected_visible_ids, {1, 3});
  expect_ok(kernel.UpdateTransforms(std::vector<ItemTransformDelta>{item(2, 20, 20, 10, 10)}));
  query = kernel.QueryVisible();
  expect_ids(query.visible_ids, {1, 2, 3});
  expect_ok(kernel.RemoveItems(std::vector<ItemId>{1}));
  query = kernel.QueryVisible();
  expect_ids(query.visible_ids, {2, 3});
  expect_ids(query.selected_ids, {3});
  assert(kernel.Validate());
}

void test_tiny_zoom_and_finite_results() {
  SceneLimits limits;
  limits.overscan_pixels = 32.0;
  SceneKernel kernel(limits);
  expect_ok(kernel.AddItems(std::vector<ItemTransformDelta>{item(1, 0, 0, 10, 10), item(2, 100000, 100000, 10, 10)}));
  expect_ok(kernel.SetViewport(ViewportUpdate{0, 0, 0.001, 100, 100, 1}));
  const auto query = kernel.QueryVisible();
  expect_ids(query.visible_ids, {1});
  for (const auto id : query.visible_ids) assert(id != 0);
  assert(kernel.Validate());
}

void test_atomic_capacity_and_invalid_delta() {
  SceneLimits limits;
  limits.max_items = 2;
  limits.max_selection = 2;
  SceneKernel kernel(limits);
  expect_ok(kernel.AddItems(std::vector<ItemTransformDelta>{item(1, 0, 0, 1, 1)}));
  const auto before_revision = kernel.scene_revision();
  expect_code(kernel.AddItems(std::vector<ItemTransformDelta>{item(2, 1, 1, 1, 1), item(3, 2, 2, 1, 1)}), ErrorCode::kCapacityExceeded);
  assert(kernel.item_count() == 1);
  assert(kernel.scene_revision() == before_revision);
  expect_code(kernel.UpdateTransforms(std::vector<ItemTransformDelta>{item(1, 0, 0, 1, 1), item(999, 0, 0, 1, 1)}), ErrorCode::kNotFound);
  assert(kernel.item_count() == 1);
  ItemTransformDelta nan_item = item(7, 0, 0, 1, 1);
  nan_item.rotation = std::numeric_limits<double>::quiet_NaN();
  expect_code(kernel.AddItems(std::vector<ItemTransformDelta>{nan_item}), ErrorCode::kNonFinite);
  assert(kernel.item_count() == 1);
  assert(kernel.Validate());
}

void test_overflow_is_bounded() {
  SceneLimits limits;
  limits.max_cells_per_item = 4;
  SceneKernel kernel(limits);
  expect_code(kernel.AddItems(std::vector<ItemTransformDelta>{item(1, 0, 0, 5000, 1)}), ErrorCode::kOverflow);
  assert(kernel.item_count() == 0);
  assert(kernel.Validate());
}

}  // namespace

int main() {
  test_rotated_negative_scale_aabb();
  test_deltas_replacement_removal_and_order();
  test_tiny_zoom_and_finite_results();
  test_atomic_capacity_and_invalid_delta();
  test_overflow_is_bounded();
  std::cout << "native_canvas_scene_kernel_test: PASS\n";
  return 0;
}
