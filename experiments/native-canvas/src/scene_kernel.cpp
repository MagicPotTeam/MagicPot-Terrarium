#include "native_canvas/scene_kernel.h"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <unordered_set>
#include <utility>

namespace native_canvas {
namespace {

bool finite(double value) { return std::isfinite(value) != 0; }
bool finite_item(const ItemTransformDelta& item) {
  return item.id != 0 && finite(item.x) && finite(item.y) && finite(item.width) &&
         finite(item.height) && finite(item.scale_x) && finite(item.scale_y) &&
         finite(item.rotation) && item.width >= 0.0 && item.height >= 0.0;
}
bool finite_viewport(const ViewportUpdate& viewport) {
  return finite(viewport.x) && finite(viewport.y) && finite(viewport.scale) &&
         finite(viewport.device_scale) && viewport.scale > 0.0 &&
         viewport.device_scale > 0.0 && viewport.width > 0 && viewport.height > 0;
}
bool valid_limits(const SceneLimits& limits) {
  return limits.max_items > 0 && limits.max_selection <= limits.max_items &&
         finite(limits.cell_size) && limits.cell_size > 0.0 &&
         finite(limits.overscan_pixels) && limits.overscan_pixels >= 0.0 &&
         limits.max_cells_per_item > 0;
}
ApplyResult fail(ErrorCode code, std::string message) { return ApplyResult{code, std::move(message)}; }
ApplyResult ok() { return ApplyResult{}; }
bool overlaps(const Rect& a, const Rect& b) {
  return a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y;
}
bool rect_equal(const Rect& a, const Rect& b) {
  return a.min_x == b.min_x && a.min_y == b.min_y && a.max_x == b.max_x && a.max_y == b.max_y;
}

}  // namespace

std::optional<Rect> ComputeConservativeAabb(const ItemTransformDelta& item) {
  if (!finite_item(item)) return std::nullopt;
  const double half_width = std::abs(item.width * item.scale_x) * 0.5;
  const double half_height = std::abs(item.height * item.scale_y) * 0.5;
  const double cosine = std::cos(item.rotation);
  const double sine = std::sin(item.rotation);
  const double extent_x = std::abs(cosine) * half_width + std::abs(sine) * half_height;
  const double extent_y = std::abs(sine) * half_width + std::abs(cosine) * half_height;
  Rect result{item.x - extent_x, item.y - extent_y, item.x + extent_x, item.y + extent_y};
  if (!finite(result.min_x) || !finite(result.min_y) || !finite(result.max_x) || !finite(result.max_y) ||
      result.min_x > result.max_x || result.min_y > result.max_y) return std::nullopt;
  return result;
}

const char* ErrorCodeName(ErrorCode code) noexcept {
  switch (code) {
    case ErrorCode::kOk: return "ok";
    case ErrorCode::kInvalidArgument: return "invalid_argument";
    case ErrorCode::kNonFinite: return "non_finite";
    case ErrorCode::kOverflow: return "overflow";
    case ErrorCode::kCapacityExceeded: return "capacity_exceeded";
    case ErrorCode::kDuplicateId: return "duplicate_id";
    case ErrorCode::kNotFound: return "not_found";
    case ErrorCode::kInternal: return "internal";
  }
  return "unknown";
}

class SceneKernel::Impl {
 public:
  explicit Impl(SceneLimits limits) : limits_(limits) { if (!valid_limits(limits_)) limits_ = SceneLimits{}; }
  struct StoredItem { ItemTransformDelta transform; Rect bounds; std::vector<std::int64_t> cells; };

  SceneLimits limits_;
  std::map<ItemId, StoredItem> items_;
  std::map<std::int64_t, std::set<ItemId>> spatial_index_;
  std::set<ItemId> selection_;
  ViewportUpdate viewport_;
  InteractionState interaction_;
  std::uint64_t revision_ = 0;

  [[nodiscard]] std::optional<std::vector<std::int64_t>> CellKeys(const Rect& bounds) const {
    const double max_index = static_cast<double>(std::numeric_limits<std::int64_t>::max());
    const double min_index = static_cast<double>(std::numeric_limits<std::int64_t>::min());
    const double min_cell_x = std::floor(bounds.min_x / limits_.cell_size);
    const double max_cell_x = std::floor(bounds.max_x / limits_.cell_size);
    const double min_cell_y = std::floor(bounds.min_y / limits_.cell_size);
    const double max_cell_y = std::floor(bounds.max_y / limits_.cell_size);
    if (!finite(min_cell_x) || !finite(max_cell_x) || !finite(min_cell_y) || !finite(max_cell_y) ||
        min_cell_x < min_index || max_cell_x > max_index || min_cell_y < min_index || max_cell_y > max_index ||
        min_cell_x > max_cell_x || min_cell_y > max_cell_y) return std::nullopt;
    const auto width = static_cast<std::uint64_t>(max_cell_x - min_cell_x + 1.0);
    const auto height = static_cast<std::uint64_t>(max_cell_y - min_cell_y + 1.0);
    if (width == 0 || height == 0 || height > limits_.max_cells_per_item / width) return std::nullopt;
    std::vector<std::int64_t> result;
    result.reserve(static_cast<std::size_t>(width * height));
    for (auto y = static_cast<std::int64_t>(min_cell_y); y <= static_cast<std::int64_t>(max_cell_y); ++y) {
      for (auto x = static_cast<std::int64_t>(min_cell_x); x <= static_cast<std::int64_t>(max_cell_x); ++x) {
        const auto zigzag = [](std::int64_t value) -> std::uint64_t {
          return value >= 0 ? static_cast<std::uint64_t>(value) * 2u : static_cast<std::uint64_t>(-(value + 1)) * 2u + 1u;
        };
        const std::uint64_t ux = zigzag(x);
        const std::uint64_t uy = zigzag(y);
        const std::uint64_t hash = (ux * 0x9e3779b97f4a7c15ULL) ^ (uy + 0x517cc1b727220a95ULL + (ux << 6) + (ux >> 2));
        result.push_back(static_cast<std::int64_t>(hash & 0x7fffffffffffffffULL));
        if (x == std::numeric_limits<std::int64_t>::max()) break;
      }
      if (y == std::numeric_limits<std::int64_t>::max()) break;
    }
    return result;
  }

  ApplyResult ValidateItems(std::span<const ItemTransformDelta> items, bool adding) const {
    std::unordered_set<ItemId> ids;
    ids.reserve(items.size());
    for (const auto& item : items) {
      if (!finite_item(item)) {
        return fail(item.id == 0 || item.width < 0.0 || item.height < 0.0 ? ErrorCode::kInvalidArgument : ErrorCode::kNonFinite,
                    "item transform must contain finite values, a nonzero id, and nonnegative dimensions");
      }
      if (!ids.insert(item.id).second) return fail(ErrorCode::kDuplicateId, "delta contains a duplicate item id");
      if (adding && items_.contains(item.id)) return fail(ErrorCode::kDuplicateId, "item already exists");
      if (!adding && !items_.contains(item.id)) return fail(ErrorCode::kNotFound, "transform item does not exist");
      const auto bounds = ComputeConservativeAabb(item);
      if (!bounds.has_value()) return fail(ErrorCode::kOverflow, "item bounds overflowed");
      if (!CellKeys(*bounds).has_value()) return fail(ErrorCode::kOverflow, "item spatial coverage exceeds bounded index limits");
    }
    if (adding && items.size() > limits_.max_items - items_.size()) return fail(ErrorCode::kCapacityExceeded, "item capacity exceeded");
    return ok();
  }
  void Unindex(const StoredItem& item) {
    for (const auto cell : item.cells) {
      auto found = spatial_index_.find(cell);
      if (found == spatial_index_.end()) continue;
      found->second.erase(item.transform.id);
      if (found->second.empty()) spatial_index_.erase(found);
    }
  }
  void Index(const StoredItem& item) { for (const auto cell : item.cells) spatial_index_[cell].insert(item.transform.id); }
  ApplyResult Store(ItemTransformDelta item) {
    const auto bounds = ComputeConservativeAabb(item);
    if (!bounds.has_value()) return fail(ErrorCode::kOverflow, "bounds overflowed");
    const auto cells = CellKeys(*bounds);
    if (!cells.has_value()) return fail(ErrorCode::kOverflow, "spatial coverage overflowed");
    StoredItem stored{item, *bounds, *cells};
    auto [it, inserted] = items_.emplace(item.id, std::move(stored));
    if (!inserted) return fail(ErrorCode::kInternal, "unexpected duplicate during store");
    Index(it->second);
    return ok();
  }
};

SceneKernel::SceneKernel(SceneLimits limits) : impl_(std::make_unique<Impl>(limits)) {}
SceneKernel::~SceneKernel() = default;
SceneKernel::SceneKernel(SceneKernel&&) noexcept = default;
SceneKernel& SceneKernel::operator=(SceneKernel&&) noexcept = default;

ApplyResult SceneKernel::AddItems(std::span<const ItemTransformDelta> items) {
  const auto validation = impl_->ValidateItems(items, true);
  if (!validation) return validation;
  std::vector<ItemId> added;
  try {
    added.reserve(items.size());
    for (const auto& item : items) {
      const auto result = impl_->Store(item);
      if (!result) {
        for (const auto id : added) { auto it = impl_->items_.find(id); if (it != impl_->items_.end()) { impl_->Unindex(it->second); impl_->items_.erase(it); } }
        return result;
      }
      added.push_back(item.id);
    }
  } catch (...) {
    for (const auto id : added) { auto it = impl_->items_.find(id); if (it != impl_->items_.end()) { impl_->Unindex(it->second); impl_->items_.erase(it); } }
    return fail(ErrorCode::kInternal, "allocation failed while adding items");
  }
  if (!items.empty()) ++impl_->revision_;
  return ok();
}

ApplyResult SceneKernel::RemoveItems(std::span<const ItemId> ids) {
  std::unordered_set<ItemId> unique;
  unique.reserve(ids.size());
  for (const auto id : ids) {
    if (id == 0) return fail(ErrorCode::kInvalidArgument, "item id must be nonzero");
    if (!unique.insert(id).second) return fail(ErrorCode::kDuplicateId, "delta contains duplicate item id");
    if (!impl_->items_.contains(id)) return fail(ErrorCode::kNotFound, "item to remove does not exist");
  }
  for (const auto id : ids) { auto it = impl_->items_.find(id); impl_->Unindex(it->second); impl_->items_.erase(it); impl_->selection_.erase(id); }
  if (!ids.empty()) ++impl_->revision_;
  return ok();
}

ApplyResult SceneKernel::UpdateTransforms(std::span<const ItemTransformDelta> items) {
  const auto validation = impl_->ValidateItems(items, false);
  if (!validation) return validation;
  std::vector<Impl::StoredItem> replacements;
  try {
    replacements.reserve(items.size());
    for (const auto& item : items) { const auto bounds = ComputeConservativeAabb(item); const auto cells = impl_->CellKeys(*bounds); replacements.push_back(Impl::StoredItem{item, *bounds, *cells}); }
  } catch (...) { return fail(ErrorCode::kInternal, "allocation failed while preparing transforms"); }
  for (const auto& replacement : replacements) { auto it = impl_->items_.find(replacement.transform.id); impl_->Unindex(it->second); it->second = replacement; impl_->Index(it->second); }
  if (!items.empty()) ++impl_->revision_;
  return ok();
}

ApplyResult SceneKernel::UpdateSelection(std::span<const ItemId> ids) {
  if (ids.size() > impl_->limits_.max_selection) return fail(ErrorCode::kCapacityExceeded, "selection capacity exceeded");
  std::unordered_set<ItemId> unique;
  unique.reserve(ids.size());
  for (const auto id : ids) {
    if (id == 0) return fail(ErrorCode::kInvalidArgument, "selected item id must be nonzero");
    if (!unique.insert(id).second) return fail(ErrorCode::kDuplicateId, "selection contains duplicate item id");
    if (!impl_->items_.contains(id)) return fail(ErrorCode::kNotFound, "selected item does not exist");
  }
  std::set<ItemId> replacement(ids.begin(), ids.end());
  if (replacement != impl_->selection_) { impl_->selection_ = std::move(replacement); ++impl_->revision_; }
  return ok();
}

ApplyResult SceneKernel::SetViewport(const ViewportUpdate& viewport) {
  if (!finite_viewport(viewport)) return fail(viewport.scale <= 0.0 || viewport.device_scale <= 0.0 ? ErrorCode::kInvalidArgument : ErrorCode::kNonFinite,
                                                   "viewport must be finite with positive scale, device scale, and dimensions");
  if (viewport.x == impl_->viewport_.x && viewport.y == impl_->viewport_.y && viewport.scale == impl_->viewport_.scale && viewport.width == impl_->viewport_.width &&
      viewport.height == impl_->viewport_.height && viewport.device_scale == impl_->viewport_.device_scale) return ok();
  impl_->viewport_ = viewport;
  ++impl_->revision_;
  return ok();
}

ApplyResult SceneKernel::SetInteractionState(const InteractionState& state) {
  if (state.pointer_down == impl_->interaction_.pointer_down && state.panning == impl_->interaction_.panning && state.dragging == impl_->interaction_.dragging) return ok();
  impl_->interaction_ = state;
  ++impl_->revision_;
  return ok();
}

QueryResult SceneKernel::QueryVisible() const {
  QueryResult result;
  result.scene_revision = impl_->revision_;
  result.selected_ids.assign(impl_->selection_.begin(), impl_->selection_.end());
  const double overscan_world = impl_->limits_.overscan_pixels / impl_->viewport_.scale;
  const Rect viewport{impl_->viewport_.x - overscan_world, impl_->viewport_.y - overscan_world,
                      impl_->viewport_.x + static_cast<double>(impl_->viewport_.width) / impl_->viewport_.scale + overscan_world,
                      impl_->viewport_.y + static_cast<double>(impl_->viewport_.height) / impl_->viewport_.scale + overscan_world};
  std::set<ItemId> candidates;
  const auto cells = impl_->CellKeys(viewport);
  if (cells.has_value()) {
    for (const auto cell : *cells) { const auto found = impl_->spatial_index_.find(cell); if (found != impl_->spatial_index_.end()) candidates.insert(found->second.begin(), found->second.end()); }
  } else {
    result.used_full_scan = true;
    for (const auto& [id, unused] : impl_->items_) { static_cast<void>(unused); candidates.insert(id); }
  }
  for (const auto id : candidates) { const auto it = impl_->items_.find(id); if (it != impl_->items_.end() && overlaps(it->second.bounds, viewport)) result.visible_ids.push_back(id); }
  std::sort(result.visible_ids.begin(), result.visible_ids.end());
  std::set_intersection(impl_->selection_.begin(), impl_->selection_.end(), result.visible_ids.begin(), result.visible_ids.end(), std::back_inserter(result.selected_visible_ids));
  return result;
}

std::size_t SceneKernel::item_count() const noexcept { return impl_->items_.size(); }
std::uint64_t SceneKernel::scene_revision() const noexcept { return impl_->revision_; }
std::vector<ItemId> SceneKernel::selected_ids() const { return {impl_->selection_.begin(), impl_->selection_.end()}; }
std::optional<Rect> SceneKernel::CachedBounds(ItemId id) const {
  const auto it = impl_->items_.find(id);
  return it == impl_->items_.end() ? std::nullopt : std::optional<Rect>(it->second.bounds);
}

bool SceneKernel::Validate(std::string* error) const {
  auto report = [&](std::string message) { if (error != nullptr) *error = std::move(message); return false; };
  if (!valid_limits(impl_->limits_)) return report("invalid limits");
  if (impl_->items_.size() > impl_->limits_.max_items) return report("item capacity exceeded");
  if (impl_->selection_.size() > impl_->limits_.max_selection) return report("selection capacity exceeded");
  for (const auto& [id, item] : impl_->items_) {
    if (id != item.transform.id) return report("item key/id mismatch");
    const auto bounds = ComputeConservativeAabb(item.transform);
    if (!bounds.has_value() || !rect_equal(*bounds, item.bounds)) return report("cached bounds mismatch");
    const auto cells = impl_->CellKeys(item.bounds);
    if (!cells.has_value() || *cells != item.cells) return report("cached cells mismatch");
    for (const auto cell : item.cells) { const auto index = impl_->spatial_index_.find(cell); if (index == impl_->spatial_index_.end() || !index->second.contains(id)) return report("missing spatial index entry"); }
  }
  for (const auto& [cell, ids] : impl_->spatial_index_) for (const auto id : ids) { const auto item = impl_->items_.find(id); if (item == impl_->items_.end() || std::find(item->second.cells.begin(), item->second.cells.end(), cell) == item->second.cells.end()) return report("stale spatial index entry"); }
  for (const auto id : impl_->selection_) if (!impl_->items_.contains(id)) return report("selection references missing item");
  return true;
}

}  // namespace native_canvas
