use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use blake3::Hasher;
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};

const DEFAULT_MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_MAX_DECODED_PIXELS: u64 = 128 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_PIXELS: u64 = 4 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MAX_DECODED_PIXELS: u64 = 512 * 1024 * 1024;
const MAX_MAX_OUTPUT_PIXELS: u64 = 64 * 1024 * 1024;
const MAX_MAX_OUTPUT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegionRequest {
    source_path: PathBuf,
    allowed_roots: Vec<PathBuf>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    #[serde(default = "default_max_source_bytes")]
    max_source_bytes: u64,
    #[serde(default = "default_max_decoded_pixels")]
    max_decoded_pixels: u64,
    #[serde(default = "default_max_output_pixels")]
    max_output_pixels: u64,
    #[serde(default = "default_max_output_bytes")]
    max_output_bytes: u64,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    cache_root: PathBuf,
    #[serde(default)]
    include_base64: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<RegionResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RegionError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionResult {
    cache_key: String,
    cache_path: String,
    source_path: String,
    source_width: u32,
    source_height: u32,
    requested_rect: Rect,
    output_width: u32,
    output_height: u32,
    output_bytes: u64,
    mime_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    base64: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn main() {
    let response = match run() {
        Ok(result) => RegionResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => RegionResponse {
            ok: false,
            result: None,
            error: Some(classify_error(&error)),
        },
    };

    let stdout = io::stdout();
    let mut output = stdout.lock();
    let _ = serde_json::to_writer(&mut output, &response);
    let _ = output.write_all(b"\n");
}

fn run() -> Result<RegionResult> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .context("failed to read JSON request")?;
    let request: RegionRequest = serde_json::from_str(&input).context("invalid JSON request")?;
    generate_region(&request)
}

fn generate_region(request: &RegionRequest) -> Result<RegionResult> {
    validate_limits(request)?;
    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    check_deadline(deadline)?;

    let source = canonical_existing_file(&request.source_path)?;
    let source_metadata = fs::metadata(&source).context("PATH: failed to stat sourcePath")?;
    if source_metadata.len() > request.max_source_bytes {
        return Err(anyhow!(
            "INPUT_LIMIT: source is {} bytes, above maxSourceBytes {}",
            source_metadata.len(),
            request.max_source_bytes
        ));
    }

    let allowed_roots = canonical_allowed_roots(&request.allowed_roots)?;
    if !allowed_roots.iter().any(|root| is_inside(root, &source)) {
        return Err(anyhow!(
            "PATH: sourcePath is outside every allowedRoots entry"
        ));
    }
    check_deadline(deadline)?;

    let dimension_reader = ImageReader::open(&source)
        .context("DECODE: failed to open source")?
        .with_guessed_format()
        .context("DECODE: failed to identify source format")?;
    let (source_width, source_height) = dimension_reader
        .into_dimensions()
        .context("DECODE: failed to read source dimensions")?;
    let source_pixels = u64::from(source_width) * u64::from(source_height);
    if source_pixels > request.max_decoded_pixels {
        return Err(anyhow!(
            "INPUT_LIMIT: source has {source_pixels} decoded pixels, above maxDecodedPixels {}",
            request.max_decoded_pixels
        ));
    }
    validate_rect(request, source_width, source_height)?;
    check_deadline(deadline)?;

    let image = ImageReader::open(&source)
        .context("DECODE: failed to open source")?
        .with_guessed_format()
        .context("DECODE: failed to identify source format")?
        .decode()
        .context("DECODE: failed to decode source")?;
    check_deadline(deadline)?;

    let cropped = image.crop_imm(request.x, request.y, request.width, request.height);
    let mut encoded = Vec::new();
    cropped
        .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
        .context("OUTPUT: failed to encode PNG")?;
    let output_bytes = encoded.len() as u64;
    if output_bytes > request.max_output_bytes {
        return Err(anyhow!(
            "OUTPUT_LIMIT: encoded output is {output_bytes} bytes, above maxOutputBytes {}",
            request.max_output_bytes
        ));
    }
    check_deadline(deadline)?;

    let cache_root = canonical_cache_root(&request.cache_root)?;
    let cache_key = build_cache_key(
        &source,
        source_metadata.len(),
        modified_nanos(&source_metadata),
        request.x,
        request.y,
        request.width,
        request.height,
    );
    let cache_path = confined_cache_path(&cache_root, &format!("{cache_key}.png"))?;
    atomic_publish(&cache_path, &encoded)?;
    check_deadline(deadline)?;

    Ok(RegionResult {
        cache_key,
        cache_path: display(&cache_path),
        source_path: display(&source),
        source_width,
        source_height,
        requested_rect: Rect {
            x: request.x,
            y: request.y,
            width: request.width,
            height: request.height,
        },
        output_width: cropped.width(),
        output_height: cropped.height(),
        output_bytes,
        mime_type: "image/png",
        base64: request
            .include_base64
            .then(|| base64::engine::general_purpose::STANDARD.encode(encoded)),
    })
}

fn validate_limits(request: &RegionRequest) -> Result<()> {
    if request.allowed_roots.is_empty() {
        return Err(anyhow!("PATH: allowedRoots must not be empty"));
    }
    if request.width == 0 || request.height == 0 {
        return Err(anyhow!("REGION_LIMIT: width and height must be positive"));
    }
    validate_limit(
        "maxSourceBytes",
        request.max_source_bytes,
        MAX_MAX_SOURCE_BYTES,
    )?;
    validate_limit(
        "maxDecodedPixels",
        request.max_decoded_pixels,
        MAX_MAX_DECODED_PIXELS,
    )?;
    validate_limit(
        "maxOutputPixels",
        request.max_output_pixels,
        MAX_MAX_OUTPUT_PIXELS,
    )?;
    validate_limit(
        "maxOutputBytes",
        request.max_output_bytes,
        MAX_MAX_OUTPUT_BYTES,
    )?;
    if request.timeout_ms == 0 || request.timeout_ms > MAX_TIMEOUT_MS {
        return Err(anyhow!(
            "TIMEOUT: timeoutMs must be between 1 and {MAX_TIMEOUT_MS}"
        ));
    }
    Ok(())
}

fn validate_limit(name: &str, value: u64, ceiling: u64) -> Result<()> {
    if value == 0 || value > ceiling {
        return Err(anyhow!(
            "INPUT_LIMIT: {name} is outside its permitted range"
        ));
    }
    Ok(())
}

fn validate_rect(request: &RegionRequest, source_width: u32, source_height: u32) -> Result<()> {
    let pixels = u64::from(request.width) * u64::from(request.height);
    if pixels > request.max_output_pixels {
        return Err(anyhow!(
            "OUTPUT_LIMIT: requested region has {pixels} pixels, above maxOutputPixels {}",
            request.max_output_pixels
        ));
    }
    let right = request
        .x
        .checked_add(request.width)
        .ok_or_else(|| anyhow!("REGION_LIMIT: x+width overflow"))?;
    let bottom = request
        .y
        .checked_add(request.height)
        .ok_or_else(|| anyhow!("REGION_LIMIT: y+height overflow"))?;
    if right > source_width || bottom > source_height {
        return Err(anyhow!(
            "REGION_LIMIT: requested region is outside source bounds"
        ));
    }
    Ok(())
}

fn canonical_existing_file(path: &Path) -> Result<PathBuf> {
    let normalized = normalize_path(path)?;
    let canonical = fs::canonicalize(&normalized).with_context(|| {
        format!(
            "PATH: failed to canonicalize sourcePath {}",
            display(&normalized)
        )
    })?;
    if !canonical.is_file() {
        return Err(anyhow!("PATH: sourcePath is not a regular file"));
    }
    Ok(canonical)
}

fn canonical_allowed_roots(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    paths
        .iter()
        .map(|path| {
            let normalized = normalize_path(path)?;
            let canonical = fs::canonicalize(&normalized).with_context(|| {
                format!(
                    "PATH: failed to canonicalize allowedRoot {}",
                    display(&normalized)
                )
            })?;
            if !canonical.is_dir() {
                return Err(anyhow!("PATH: allowedRoot is not a directory"));
            }
            Ok(canonical)
        })
        .collect()
}

fn canonical_cache_root(path: &Path) -> Result<PathBuf> {
    let normalized = normalize_path(path)?;
    fs::create_dir_all(&normalized)
        .with_context(|| format!("CACHE: failed to create cacheRoot {}", display(&normalized)))?;
    fs::canonicalize(&normalized).context("CACHE: failed to canonicalize cacheRoot")
}

fn normalize_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.strip_prefix(root).is_ok()
}

fn confined_cache_path(root: &Path, file_name: &str) -> Result<PathBuf> {
    let component = Path::new(file_name);
    if component.is_absolute()
        || component.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("CACHE: invalid cache file name"));
    }
    let result = root.join(component);
    if !is_inside(root, &result) {
        return Err(anyhow!("CACHE: cache path escaped cacheRoot"));
    }
    Ok(result)
}

fn atomic_publish(path: &Path, data: &[u8]) -> Result<()> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).context("CACHE: failed to inspect cache path")?;
        if !metadata.file_type().is_file() {
            return Err(anyhow!("CACHE: existing cache path is not a regular file"));
        }
        return Ok(());
    }

    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("CACHE: cache path has no parent"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("CACHE: cache path has no file name"))?
        .to_string_lossy();
    let temp = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    {
        let mut file = File::create(&temp).context("CACHE: failed to create temporary output")?;
        file.write_all(data)
            .context("CACHE: failed to write temporary output")?;
        file.sync_all()
            .context("CACHE: failed to sync temporary output")?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        if path.is_file() {
            return Ok(());
        }
        return Err(error).context("CACHE: atomic rename failed");
    }
    Ok(())
}

fn build_cache_key(
    source: &Path,
    source_size: u64,
    source_modified_nanos: u128,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> String {
    let mut hasher = Hasher::new();
    hasher.update(display(source).as_bytes());
    hasher.update(&source_size.to_le_bytes());
    hasher.update(&source_modified_nanos.to_le_bytes());
    for value in [x, y, width, height] {
        hasher.update(&value.to_le_bytes());
    }
    format!("region-{}", &hasher.finalize().to_hex().to_string()[..32])
}

fn modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or(0)
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() > deadline {
        return Err(anyhow!("TIMEOUT: cooperative deadline exceeded"));
    }
    Ok(())
}

fn classify_error(error: &anyhow::Error) -> RegionError {
    let message = format!("{error:#}");
    let code = [
        "PATH",
        "INPUT_LIMIT",
        "REGION_LIMIT",
        "OUTPUT_LIMIT",
        "TIMEOUT",
        "DECODE",
        "CACHE",
    ]
    .iter()
    .find(|prefix| message.starts_with(**prefix))
    .copied()
    .unwrap_or("INTERNAL");
    RegionError { code, message }
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn default_max_source_bytes() -> u64 {
    DEFAULT_MAX_SOURCE_BYTES
}

fn default_max_decoded_pixels() -> u64 {
    DEFAULT_MAX_DECODED_PIXELS
}

fn default_max_output_pixels() -> u64 {
    DEFAULT_MAX_OUTPUT_PIXELS
}

fn default_max_output_bytes() -> u64 {
    DEFAULT_MAX_OUTPUT_BYTES
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use tempfile::TempDir;

    fn make_source(root: &Path) -> PathBuf {
        let source = root.join("source.png");
        let image = ImageBuffer::from_pixel(8, 6, Rgba([10u8, 20u8, 30u8, 255u8]));
        image.save(&source).unwrap();
        source
    }

    fn request(root: &Path, source: &Path) -> RegionRequest {
        RegionRequest {
            source_path: source.to_path_buf(),
            allowed_roots: vec![root.to_path_buf()],
            x: 1,
            y: 1,
            width: 4,
            height: 3,
            max_source_bytes: DEFAULT_MAX_SOURCE_BYTES,
            max_decoded_pixels: DEFAULT_MAX_DECODED_PIXELS,
            max_output_pixels: 100,
            max_output_bytes: 1_000_000,
            timeout_ms: DEFAULT_TIMEOUT_MS,
            cache_root: root.join("cache"),
            include_base64: false,
        }
    }

    #[test]
    fn rejects_source_outside_allowed_root() {
        let allowed = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let source = make_source(outside.path());
        let request = request(allowed.path(), &source);
        let error = generate_region(&request).unwrap_err();
        assert!(format!("{error:#}").contains("outside every allowedRoots"));
    }

    #[test]
    fn rejects_pixel_limit_and_out_of_bounds_region() {
        let temp = TempDir::new().unwrap();
        let source = make_source(temp.path());
        let mut request = request(temp.path(), &source);
        request.max_output_pixels = 1;
        let error = generate_region(&request).unwrap_err();
        assert!(format!("{error:#}").contains("above maxOutputPixels"));

        request.max_output_pixels = 100;
        request.x = 7;
        assert!(format!("{:#}", generate_region(&request).unwrap_err())
            .contains("outside source bounds"));
    }

    #[test]
    fn cache_key_changes_with_region() {
        let temp = TempDir::new().unwrap();
        let source = make_source(temp.path());
        assert_ne!(
            build_cache_key(&source, 1, 2, 0, 0, 2, 2),
            build_cache_key(&source, 1, 2, 1, 0, 2, 2)
        );
    }

    #[test]
    fn publishes_png_atomically_and_is_idempotent() {
        let temp = TempDir::new().unwrap();
        let source = make_source(temp.path());
        let request = request(temp.path(), &source);
        let first = generate_region(&request).unwrap();
        let second = generate_region(&request).unwrap();
        assert_eq!(first.cache_key, second.cache_key);
        assert_eq!(first.requested_rect, second.requested_rect);
        assert!(Path::new(&first.cache_path).is_file());
        assert!(!fs::read_dir(request.cache_root).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .and_then(|v| v.to_str())
            == Some("tmp")));
    }

    #[test]
    fn rejects_output_byte_limit() {
        let temp = TempDir::new().unwrap();
        let source = make_source(temp.path());
        let mut request = request(temp.path(), &source);
        request.max_output_bytes = 1;
        let error = generate_region(&request).unwrap_err();
        assert!(format!("{error:#}").contains("above maxOutputBytes"));
    }

    #[test]
    fn classifies_errors_with_stable_codes() {
        let error = classify_error(&anyhow!("PATH: denied"));
        assert_eq!(error.code, "PATH");
        let error = classify_error(&anyhow!("unclassified"));
        assert_eq!(error.code, "INTERNAL");
    }
}
