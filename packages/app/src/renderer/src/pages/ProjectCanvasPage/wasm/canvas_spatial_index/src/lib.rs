use std::collections::{HashMap, HashSet};
use wasm_bindgen::prelude::*;

const BOUNDS_STRIDE: usize = 4;

#[derive(Clone, Copy)]
struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

#[derive(Clone, Copy)]
struct CellRange {
    min_cell_x: i32,
    max_cell_x: i32,
    min_cell_y: i32,
    max_cell_y: i32,
    cell_count: f64,
}

fn normalize_bounds(raw: &[f64], offset: usize) -> Option<Bounds> {
    if offset + BOUNDS_STRIDE > raw.len() {
        return None;
    }

    let min_x = raw[offset];
    let min_y = raw[offset + 1];
    let max_x = raw[offset + 2];
    let max_y = raw[offset + 3];

    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return None;
    }

    Some(Bounds {
        min_x: min_x.min(max_x),
        min_y: min_y.min(max_y),
        max_x: min_x.max(max_x),
        max_y: min_y.max(max_y),
    })
}

fn bounds_intersect(left: Bounds, right: Bounds) -> bool {
    left.min_x < right.max_x
        && left.max_x > right.min_x
        && left.min_y < right.max_y
        && left.max_y > right.min_y
}

fn cell_range(bounds: Bounds, cell_size: f64) -> Option<CellRange> {
    let safe_cell_size = if cell_size.is_finite() && cell_size > 0.0 {
        cell_size
    } else {
        512.0
    };

    let min_cell_x = (bounds.min_x / safe_cell_size).floor();
    let max_cell_x = (bounds.max_x / safe_cell_size).floor();
    let min_cell_y = (bounds.min_y / safe_cell_size).floor();
    let max_cell_y = (bounds.max_y / safe_cell_size).floor();
    if !min_cell_x.is_finite()
        || !max_cell_x.is_finite()
        || !min_cell_y.is_finite()
        || !max_cell_y.is_finite()
    {
        return None;
    }

    let columns = max_cell_x - min_cell_x + 1.0;
    let rows = max_cell_y - min_cell_y + 1.0;
    let cell_count = columns * rows;
    if !cell_count.is_finite() || columns <= 0.0 || rows <= 0.0 {
        return None;
    }

    Some(CellRange {
        min_cell_x: min_cell_x as i32,
        max_cell_x: max_cell_x as i32,
        min_cell_y: min_cell_y as i32,
        max_cell_y: max_cell_y as i32,
        cell_count,
    })
}

fn cell_key(cell_x: i32, cell_y: i32) -> i64 {
    ((cell_x as i64) << 32) ^ ((cell_y as i64) & 0xffff_ffff)
}

#[wasm_bindgen]
pub struct SpatialIndex {
    bounds: Vec<Bounds>,
    original_indexes: Vec<u32>,
    cells: HashMap<i64, Vec<u32>>,
    overflow_entry_indexes: Vec<u32>,
    cell_size: f64,
    max_indexed_cells_per_entry: f64,
    max_query_cells: f64,
}

#[wasm_bindgen]
impl SpatialIndex {
    #[wasm_bindgen(constructor)]
    pub fn new(
        flattened_bounds: &[f64],
        cell_size: f64,
        max_indexed_cells_per_entry: u32,
        max_query_cells: u32,
    ) -> SpatialIndex {
        let mut bounds = Vec::with_capacity(flattened_bounds.len() / BOUNDS_STRIDE);
        let mut original_indexes = Vec::with_capacity(flattened_bounds.len() / BOUNDS_STRIDE);
        let mut cells: HashMap<i64, Vec<u32>> = HashMap::new();
        let mut overflow_entry_indexes = Vec::new();
        let max_indexed_cells = max_indexed_cells_per_entry as f64;

        for original_index in 0..(flattened_bounds.len() / BOUNDS_STRIDE) {
            let Some(normalized_bounds) = normalize_bounds(flattened_bounds, original_index * BOUNDS_STRIDE)
            else {
                continue;
            };

            let entry_index = bounds.len() as u32;
            bounds.push(normalized_bounds);
            original_indexes.push(original_index as u32);

            let Some(range) = cell_range(normalized_bounds, cell_size) else {
                continue;
            };

            if range.cell_count > max_indexed_cells {
                overflow_entry_indexes.push(entry_index);
                continue;
            }

            for cell_y in range.min_cell_y..=range.max_cell_y {
                for cell_x in range.min_cell_x..=range.max_cell_x {
                    cells.entry(cell_key(cell_x, cell_y)).or_default().push(entry_index);
                }
            }
        }

        SpatialIndex {
            bounds,
            original_indexes,
            cells,
            overflow_entry_indexes,
            cell_size,
            max_indexed_cells_per_entry: max_indexed_cells,
            max_query_cells: max_query_cells as f64,
        }
    }

    pub fn query(&self, query_bounds: &[f64]) -> Vec<u32> {
        let Some(normalized_query_bounds) = normalize_bounds(query_bounds, 0) else {
            return Vec::new();
        };

        let Some(range) = cell_range(normalized_query_bounds, self.cell_size) else {
            return self.linear_query(normalized_query_bounds);
        };

        if range.cell_count > self.max_query_cells {
            return self.linear_query(normalized_query_bounds);
        }

        let mut candidates: HashSet<u32> = HashSet::new();
        for entry_index in &self.overflow_entry_indexes {
            candidates.insert(*entry_index);
        }

        for cell_y in range.min_cell_y..=range.max_cell_y {
            for cell_x in range.min_cell_x..=range.max_cell_x {
                if let Some(bucket) = self.cells.get(&cell_key(cell_x, cell_y)) {
                    for entry_index in bucket {
                        candidates.insert(*entry_index);
                    }
                }
            }
        }

        let mut candidate_indexes: Vec<u32> = candidates.into_iter().collect();
        candidate_indexes.sort_unstable();

        let mut matches = Vec::new();
        for entry_index in candidate_indexes {
            let Some(bounds) = self.bounds.get(entry_index as usize) else {
                continue;
            };
            if bounds_intersect(*bounds, normalized_query_bounds) {
                if let Some(original_index) = self.original_indexes.get(entry_index as usize) {
                    matches.push(*original_index);
                }
            }
        }

        matches
    }

    pub fn entry_count(&self) -> usize {
        self.bounds.len()
    }

    pub fn overflow_entry_count(&self) -> usize {
        self.overflow_entry_indexes.len()
    }

    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn max_indexed_cells_per_entry(&self) -> f64 {
        self.max_indexed_cells_per_entry
    }

    fn linear_query(&self, query_bounds: Bounds) -> Vec<u32> {
        let mut matches = Vec::new();
        for (entry_index, bounds) in self.bounds.iter().enumerate() {
            if bounds_intersect(*bounds, query_bounds) {
                if let Some(original_index) = self.original_indexes.get(entry_index) {
                    matches.push(*original_index);
                }
            }
        }
        matches
    }
}
