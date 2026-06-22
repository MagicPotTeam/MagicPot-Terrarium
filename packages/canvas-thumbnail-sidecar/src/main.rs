use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use clap::Parser;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DEFAULT_THUMB_LEVELS: [u32; 5] = [128, 256, 512, 1024, 2048];
const DEFAULT_MAX_DECODED_PIXELS: u64 = 64 * 1024 * 1024;
const HASH_CHUNK_BYTES: usize = 1024 * 1024;
const CANVAS_THUMBNAIL_VERSION: u32 = 1;
const CACHE_KEY_PREFIX: &str = "thumb";
const MAX_THUMB_LEVEL: u32 = 8192;

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Generate canvas image thumbnail manifests from a JSON batch request"
)]
struct Cli {
    /// Read JSON request from this file instead of stdin.
    #[arg(short, long)]
    input: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchRequest {
    cache_root: PathBuf,
    items: Vec<WorkItem>,
    #[serde(default)]
    thumbnail: ThumbnailRequest,
    #[serde(default)]
    max_concurrency: Option<usize>,
    #[serde(default = "default_max_decoded_pixels")]
    max_decoded_pixels: u64,
    #[serde(default)]
    hash: HashAlgorithm,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkItem {
    id: String,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HashAlgorithm {
    Blake3,
    Sha256,
}

impl Default for HashAlgorithm {
    fn default() -> Self {
        Self::Blake3
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailRequest {
    #[serde(default)]
    levels: Option<Vec<u32>>,
    #[serde(default)]
    max_side: Option<u32>,
    #[serde(default)]
    max_width: Option<u32>,
    #[serde(default)]
    max_height: Option<u32>,
    #[serde(default)]
    allow_upscale: bool,
    #[serde(default)]
    format: ThumbnailFormat,
}

impl Default for ThumbnailRequest {
    fn default() -> Self {
        Self {
            levels: None,
            max_side: None,
            max_width: None,
            max_height: None,
            allow_upscale: false,
            format: ThumbnailFormat::Png,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ThumbnailFormat {
    Png,
    Jpg,
    Jpeg,
    Webp,
}

impl Default for ThumbnailFormat {
    fn default() -> Self {
        Self::Png
    }
}

impl ThumbnailFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg | Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    fn image_format(self) -> ImageFormat {
        match self {
            Self::Png => ImageFormat::Png,
            Self::Jpg | Self::Jpeg => ImageFormat::Jpeg,
            Self::Webp => ImageFormat::WebP,
        }
    }

    fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpg | Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchResponse {
    ok: bool,
    cache_root: String,
    results: Vec<ItemResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemResult {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<ThumbnailManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ItemError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemError {
    code: &'static str,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailManifest {
    schema_version: u32,
    version: u32,
    id: String,
    cache_key: String,
    canonical_path: String,
    source_size_bytes: u64,
    source_last_modified_ms: u64,
    source_width: u32,
    source_height: u32,
    source_identity: SourceIdentity,
    source: SourceMetadata,
    hash: FileHash,
    levels: Vec<ThumbnailLevelMetadata>,
    thumbnail: ThumbnailMetadata,
    manifest_path: String,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceIdentity {
    kind: &'static str,
    canonical_path: String,
    size_bytes: u64,
    last_modified_ms: u64,
    cache_key: String,
    cache_root_dir: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceMetadata {
    path: String,
    canonical_path: String,
    byte_length: u64,
    size_bytes: u64,
    last_modified_ms: u64,
    width: u32,
    height: u32,
    color_type: String,
    format: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHash {
    algorithm: &'static str,
    hex: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailLevelMetadata {
    max_side: u32,
    width: u32,
    height: u32,
    filename: String,
    path: String,
    src: String,
    mime_type: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThumbnailMetadata {
    max_side: u32,
    path: String,
    width: u32,
    height: u32,
    filename: String,
    mime_type: String,
    size_bytes: u64,
    format: ThumbnailFormat,
}

#[derive(Clone, Debug)]
struct RuntimeOptions {
    cache_root: Arc<PathBuf>,
    thumbnail: ThumbnailRequest,
    levels: Vec<u32>,
    max_decoded_pixels: u64,
    hash: HashAlgorithm,
}

fn main() {
    if let Err(error) = run_cli() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run_cli() -> Result<()> {
    let cli = Cli::parse();
    let input = read_input(cli.input.as_deref())?;
    let request: BatchRequest = serde_json::from_str(&input).context("invalid JSON request")?;
    let response = process_batch(request)?;
    serde_json::to_writer_pretty(io::stdout(), &response)
        .context("failed to write JSON response")?;
    io::stdout().write_all(b"\n").ok();
    Ok(())
}

fn read_input(path: Option<&Path>) -> Result<String> {
    match path {
        Some(path) => fs::read_to_string(path)
            .with_context(|| format!("failed to read input file {}", display_path(path))),
        None => {
            let mut input = String::new();
            io::stdin()
                .read_to_string(&mut input)
                .context("failed to read JSON request from stdin")?;
            Ok(input)
        }
    }
}

fn process_batch(request: BatchRequest) -> Result<BatchResponse> {
    let levels = resolve_thumbnail_levels(&request.thumbnail)?;

    let cache_root = normalize_cache_root(&request.cache_root)?;
    fs::create_dir_all(&cache_root)
        .with_context(|| format!("failed to create cacheRoot {}", display_path(&cache_root)))?;
    let cache_root = fs::canonicalize(&cache_root).with_context(|| {
        format!(
            "failed to canonicalize cacheRoot {}",
            display_path(&cache_root)
        )
    })?;

    let worker_count = bounded_worker_count(request.max_concurrency, request.items.len());
    let options = RuntimeOptions {
        cache_root: Arc::new(cache_root.clone()),
        thumbnail: request.thumbnail,
        levels,
        max_decoded_pixels: request.max_decoded_pixels,
        hash: request.hash,
    };

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_count)
        .build()
        .context("failed to build thumbnail worker pool")?;

    let results = pool.install(|| {
        request
            .items
            .into_par_iter()
            .map(|item| process_item(item, &options))
            .collect::<Vec<_>>()
    });

    Ok(BatchResponse {
        ok: true,
        cache_root: display_path(&cache_root),
        results,
    })
}

fn resolve_thumbnail_levels(thumbnail: &ThumbnailRequest) -> Result<Vec<u32>> {
    let raw_levels = if let Some(levels) = thumbnail.levels.as_ref() {
        if levels.is_empty() {
            return Err(anyhow!("thumbnail levels must not be empty"));
        }
        levels.clone()
    } else if let Some(max_side) = thumbnail.max_side {
        vec![max_side]
    } else if let (Some(max_width), Some(max_height)) = (thumbnail.max_width, thumbnail.max_height)
    {
        vec![max_width.min(max_height)]
    } else {
        DEFAULT_THUMB_LEVELS.to_vec()
    };

    normalize_thumbnail_levels(raw_levels)
}

fn normalize_thumbnail_levels(mut levels: Vec<u32>) -> Result<Vec<u32>> {
    if levels.iter().any(|level| *level == 0) {
        return Err(anyhow!("thumbnail levels must be greater than zero"));
    }
    if levels.iter().any(|level| *level > MAX_THUMB_LEVEL) {
        return Err(anyhow!(
            "thumbnail levels must be less than or equal to {MAX_THUMB_LEVEL}"
        ));
    }

    levels.sort_unstable();
    levels.dedup();
    if levels.is_empty() {
        return Err(anyhow!("thumbnail levels must not be empty"));
    }
    Ok(levels)
}

fn bounded_worker_count(requested: Option<usize>, item_count: usize) -> usize {
    let available = std::thread::available_parallelism().map_or(1, usize::from);
    let requested = requested.unwrap_or(available).max(1);
    requested.min(item_count.max(1))
}

fn process_item(item: WorkItem, options: &RuntimeOptions) -> ItemResult {
    let id = item.id;
    match process_item_inner(&id, &item.path, options) {
        Ok(manifest) => ItemResult {
            id,
            ok: true,
            manifest: Some(manifest),
            error: None,
        },
        Err(error) => ItemResult {
            id,
            ok: false,
            manifest: None,
            error: Some(ItemError {
                code: "PROCESS_IMAGE_FAILED",
                message: format!("{error:#}"),
            }),
        },
    }
}

fn process_item_inner(
    id: &str,
    path: &Path,
    options: &RuntimeOptions,
) -> Result<ThumbnailManifest> {
    let source_path = normalize_input_path(path)?;
    let file_meta = fs::metadata(&source_path)
        .with_context(|| format!("failed to stat source {}", display_path(&source_path)))?;
    if !file_meta.is_file() {
        return Err(anyhow!(
            "source is not a file: {}",
            display_path(&source_path)
        ));
    }

    let source_size_bytes = file_meta.len();
    let source_last_modified_ms = modified_ms(&file_meta);
    let canonical_path = display_path(&source_path);
    let cache_key = build_canvas_thumbnail_cache_key(
        &canonical_path,
        source_size_bytes,
        source_last_modified_ms,
    );
    let hash = hash_file(&source_path, options.hash)?;

    let reader = ImageReader::open(&source_path)
        .with_context(|| format!("failed to open image {}", display_path(&source_path)))?;
    let reader = reader
        .with_guessed_format()
        .context("failed to detect image format")?;
    let image_format = reader
        .format()
        .ok_or_else(|| anyhow!("unsupported or unknown image format"))?;
    ensure_supported_input_format(image_format)?;

    let (width, height) = reader
        .into_dimensions()
        .context("failed to read image dimensions")?;
    guard_decoded_pixels(width, height, options.max_decoded_pixels)?;

    let image = image::open(&source_path)
        .with_context(|| format!("failed to decode image {}", display_path(&source_path)))?;
    let color_type = format!("{:?}", image.color());

    let entry_dir = ensure_confined_dir(&options.cache_root, &[&cache_key])?;
    let mut levels = Vec::with_capacity(options.levels.len());
    for max_side in &options.levels {
        let level = create_thumbnail_level(
            &image,
            *max_side,
            &entry_dir,
            options.thumbnail.format,
            options.thumbnail.allow_upscale,
        )?;
        levels.push(level);
    }

    let thumbnail = levels
        .last()
        .cloned()
        .ok_or_else(|| anyhow!("thumbnail level list is empty"))?;
    let manifest_path = confined_join(&entry_dir, &["manifest.json"])?;
    let timestamp = timestamp_string();
    let manifest = ThumbnailManifest {
        schema_version: CANVAS_THUMBNAIL_VERSION,
        version: CANVAS_THUMBNAIL_VERSION,
        id: id.to_owned(),
        cache_key: cache_key.clone(),
        canonical_path: canonical_path.clone(),
        source_size_bytes,
        source_last_modified_ms,
        source_width: width,
        source_height: height,
        source_identity: SourceIdentity {
            kind: "local-file",
            canonical_path: canonical_path.clone(),
            size_bytes: source_size_bytes,
            last_modified_ms: source_last_modified_ms,
            cache_key: cache_key.clone(),
            cache_root_dir: display_path(&options.cache_root),
        },
        source: SourceMetadata {
            path: canonical_path.clone(),
            canonical_path,
            byte_length: source_size_bytes,
            size_bytes: source_size_bytes,
            last_modified_ms: source_last_modified_ms,
            width,
            height,
            color_type,
            format: format!("{:?}", image_format).to_ascii_lowercase(),
        },
        hash,
        levels,
        thumbnail: ThumbnailMetadata {
            max_side: thumbnail.max_side,
            path: thumbnail.path.clone(),
            width: thumbnail.width,
            height: thumbnail.height,
            filename: thumbnail.filename.clone(),
            mime_type: thumbnail.mime_type.clone(),
            size_bytes: thumbnail.size_bytes,
            format: options.thumbnail.format,
        },
        manifest_path: display_path(&manifest_path),
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };

    write_json_atomic(&manifest_path, &manifest)
        .with_context(|| format!("failed to write manifest {}", display_path(&manifest_path)))?;
    Ok(manifest)
}

fn create_thumbnail_level(
    image: &DynamicImage,
    max_side: u32,
    entry_dir: &Path,
    format: ThumbnailFormat,
    allow_upscale: bool,
) -> Result<ThumbnailLevelMetadata> {
    let thumbnail_image = create_thumbnail(image, max_side, allow_upscale);
    let (thumb_width, thumb_height) = thumbnail_image.dimensions();
    let filename = format!("{}.{}", max_side, format.extension());
    let thumb_path = confined_join(entry_dir, &[&filename])?;
    let size_bytes = write_image_atomic(&thumbnail_image, &thumb_path, format)
        .with_context(|| format!("failed to write thumbnail {}", display_path(&thumb_path)))?;

    Ok(ThumbnailLevelMetadata {
        max_side,
        width: thumb_width,
        height: thumb_height,
        filename,
        path: display_path(&thumb_path),
        src: local_media_url(&thumb_path),
        mime_type: format.mime_type().to_owned(),
        size_bytes,
    })
}

fn ensure_supported_input_format(format: ImageFormat) -> Result<()> {
    match format {
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp => Ok(()),
        other => Err(anyhow!("unsupported image format: {other:?}")),
    }
}

fn guard_decoded_pixels(width: u32, height: u32, max_decoded_pixels: u64) -> Result<()> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > max_decoded_pixels {
        return Err(anyhow!(
            "decoded pixel guard rejected image: {width}x{height} ({pixels} pixels) exceeds limit {max_decoded_pixels}"
        ));
    }
    Ok(())
}

fn create_thumbnail(image: &DynamicImage, max_side: u32, allow_upscale: bool) -> DynamicImage {
    let (width, height) = image.dimensions();
    let (target_width, target_height) =
        thumbnail_dimensions(width, height, max_side, allow_upscale);
    if target_width == width && target_height == height {
        return image.clone();
    }
    image.resize_exact(target_width, target_height, FilterType::Triangle)
}

fn thumbnail_dimensions(
    source_width: u32,
    source_height: u32,
    max_side: u32,
    allow_upscale: bool,
) -> (u32, u32) {
    let source_max_side = source_width.max(source_height).max(1);
    let scale = f64::from(max_side) / f64::from(source_max_side);
    let scale = if allow_upscale { scale } else { scale.min(1.0) };
    let target_width = (f64::from(source_width) * scale).round().max(1.0) as u32;
    let target_height = (f64::from(source_height) * scale).round().max(1.0) as u32;
    (target_width, target_height)
}

fn hash_file(path: &Path, algorithm: HashAlgorithm) -> Result<FileHash> {
    let file = File::open(path)
        .with_context(|| format!("failed to open source for hashing {}", display_path(path)))?;
    let mut reader = BufReader::with_capacity(HASH_CHUNK_BYTES, file);
    let mut buffer = vec![0_u8; HASH_CHUNK_BYTES];

    match algorithm {
        HashAlgorithm::Blake3 => {
            let mut hasher = blake3::Hasher::new();
            loop {
                let bytes_read = reader
                    .read(&mut buffer)
                    .context("failed while hashing source")?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
            }
            Ok(FileHash {
                algorithm: "blake3",
                hex: hasher.finalize().to_hex().to_string(),
            })
        }
        HashAlgorithm::Sha256 => {
            let mut hasher = Sha256::new();
            loop {
                let bytes_read = reader
                    .read(&mut buffer)
                    .context("failed while hashing source")?;
                if bytes_read == 0 {
                    break;
                }
                hasher.update(&buffer[..bytes_read]);
            }
            Ok(FileHash {
                algorithm: "sha256",
                hex: format!("{:x}", hasher.finalize()),
            })
        }
    }
}

fn write_image_atomic(
    image: &DynamicImage,
    final_path: &Path,
    format: ThumbnailFormat,
) -> Result<u64> {
    let parent = final_path
        .parent()
        .ok_or_else(|| anyhow!("thumbnail path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp_path = unique_temp_path(
        parent,
        final_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("thumbnail"),
    );
    image.save_with_format(&temp_path, format.image_format())?;
    let size_bytes = fs::metadata(&temp_path)?.len();
    replace_file(&temp_path, final_path)?;
    Ok(size_bytes)
}

fn write_json_atomic<T: Serialize>(final_path: &Path, value: &T) -> Result<()> {
    let parent = final_path
        .parent()
        .ok_or_else(|| anyhow!("manifest path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp_path = unique_temp_path(
        parent,
        final_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("manifest"),
    );
    {
        let mut file = File::create(&temp_path)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all().ok();
    }
    replace_file(&temp_path, final_path)?;
    Ok(())
}

fn replace_file(temp_path: &Path, final_path: &Path) -> Result<()> {
    match fs::rename(temp_path, final_path) {
        Ok(()) => Ok(()),
        Err(error) if final_path.exists() => {
            fs::remove_file(final_path)?;
            fs::rename(temp_path, final_path).with_context(|| {
                format!(
                    "failed to replace {} after initial rename error: {error}",
                    display_path(final_path)
                )
            })
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to move temporary file into {}",
                display_path(final_path)
            )
        }),
    }
}

fn unique_temp_path(parent: &Path, file_name: &str) -> PathBuf {
    let encoded_thread = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!("{:?}", std::thread::current().id()));
    parent.join(format!(
        ".{file_name}.{encoded_thread}.{}.tmp",
        std::process::id()
    ))
}

fn confined_join(root: &Path, parts: &[&str]) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for part in parts {
        let part_path = Path::new(part);
        if part_path.is_absolute()
            || part_path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(anyhow!("refusing to write outside cacheRoot"));
        }
        path.push(part_path);
    }

    if !path.starts_with(root) {
        return Err(anyhow!("refusing to write outside cacheRoot"));
    }
    Ok(path)
}

fn ensure_confined_dir(root: &Path, parts: &[&str]) -> Result<PathBuf> {
    let requested = confined_join(root, parts)?;
    fs::create_dir_all(&requested).with_context(|| {
        format!(
            "failed to create cache directory {}",
            display_path(&requested)
        )
    })?;
    let canonical = fs::canonicalize(&requested).with_context(|| {
        format!(
            "failed to canonicalize cache directory {}",
            display_path(&requested)
        )
    })?;
    if !canonical.starts_with(root) {
        return Err(anyhow!("refusing to write outside cacheRoot"));
    }
    Ok(canonical)
}

fn normalize_cache_root(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(path)
}

fn normalize_input_path(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    fs::canonicalize(&path)
        .with_context(|| format!("failed to canonicalize source {}", display_path(&path)))
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn normalize_identity_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("//?/UNC/") {
        normalized = format!("//{rest}");
    } else if let Some(rest) = normalized.strip_prefix("//?/") {
        normalized = rest.to_owned();
    }

    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_uppercase() {
        normalized.replace_range(0..1, &(bytes[0] as char).to_ascii_lowercase().to_string());
    }
    normalized
}

fn build_canvas_thumbnail_cache_key(
    canonical_path: &str,
    size_bytes: u64,
    last_modified_ms: u64,
) -> String {
    let identity = [
        normalize_identity_path(canonical_path),
        size_bytes.to_string(),
        last_modified_ms.to_string(),
    ]
    .join("\n");
    format!(
        "{CACHE_KEY_PREFIX}-{}{}",
        fnv1a32(&identity, 0x811c9dc5),
        fnv1a32(&identity, 0x9e3779b9)
    )
}

fn fnv1a32(value: &str, seed: u32) -> String {
    let mut hash = seed;
    for unit in value.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

fn modified_ms(file_meta: &fs::Metadata) -> u64 {
    file_meta
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn timestamp_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("unix-ms:{millis}")
}

fn local_media_url(path: &Path) -> String {
    let normalized = display_path(path).replace('\\', "/");
    let encoded = percent_encode_path(&normalized);
    if encoded.starts_with('/') {
        format!("local-media://{encoded}")
    } else {
        format!("local-media:///{encoded}")
    }
}

fn percent_encode_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                encoded.push(char::from(*byte))
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

fn default_max_decoded_pixels() -> u64 {
    DEFAULT_MAX_DECODED_PIXELS
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use tempfile::TempDir;

    #[test]
    fn processes_supported_formats_and_keeps_batch_errors_per_item() {
        let temp = TempDir::new().expect("temp dir");
        let source_dir = temp.path().join("输入");
        fs::create_dir_all(&source_dir).expect("source dir");
        let png = source_dir.join("图像.png");
        let jpg = source_dir.join("photo.jpg");
        let webp = source_dir.join("preview.webp");
        let bmp = source_dir.join("bitmap.bmp");

        save_test_image(&png, ImageFormat::Png, 80, 40);
        save_test_image(&jpg, ImageFormat::Jpeg, 48, 72);
        save_test_image(&webp, ImageFormat::WebP, 32, 32);
        save_test_image(&bmp, ImageFormat::Bmp, 16, 24);

        let request = BatchRequest {
            cache_root: temp.path().join("cache"),
            items: vec![
                WorkItem {
                    id: "png".into(),
                    path: png.clone(),
                },
                WorkItem {
                    id: "jpg".into(),
                    path: jpg,
                },
                WorkItem {
                    id: "webp".into(),
                    path: webp,
                },
                WorkItem {
                    id: "bmp".into(),
                    path: bmp,
                },
                WorkItem {
                    id: "missing".into(),
                    path: source_dir.join("missing.png"),
                },
            ],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![20]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: false,
                format: ThumbnailFormat::Png,
            },
            max_concurrency: Some(2),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        };

        let response = process_batch(request).expect("batch response");
        assert!(response.ok);
        assert_eq!(response.results.len(), 5);
        assert_eq!(
            response.results.iter().filter(|result| result.ok).count(),
            4
        );
        assert_eq!(
            response.results.iter().filter(|result| !result.ok).count(),
            1
        );

        let png_result = response
            .results
            .iter()
            .find(|result| result.id == "png")
            .unwrap();
        let manifest = png_result.manifest.as_ref().unwrap();
        assert_eq!(manifest.source.width, 80);
        assert_eq!(manifest.source.height, 40);
        assert_eq!(manifest.levels.len(), 1);
        assert_eq!(manifest.levels[0].max_side, 20);
        assert!(manifest.source.path.contains("图像.png"));
        assert!(Path::new(&manifest.thumbnail.path).exists());
        assert!(Path::new(&manifest.manifest_path).exists());
        let expected_cache_root = fs::canonicalize(temp.path().join("cache")).unwrap();
        assert!(Path::new(&manifest.thumbnail.path).starts_with(expected_cache_root));
    }

    #[test]
    fn writes_default_project_canvas_multi_level_output() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("wide.png");
        save_test_image(&source, ImageFormat::Png, 4096, 2048);

        let request = BatchRequest {
            cache_root: temp.path().join("cache"),
            items: vec![WorkItem {
                id: "asset".into(),
                path: source.clone(),
            }],
            thumbnail: ThumbnailRequest::default(),
            max_concurrency: Some(1),
            max_decoded_pixels: 10_000_000,
            hash: HashAlgorithm::Sha256,
        };

        let response = process_batch(request).expect("batch response");
        let manifest = response.results[0].manifest.as_ref().unwrap();
        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.source_width, 4096);
        assert_eq!(manifest.source_height, 2048);
        assert_eq!(manifest.levels.len(), DEFAULT_THUMB_LEVELS.len());
        assert_eq!(
            manifest
                .levels
                .iter()
                .map(|level| level.max_side)
                .collect::<Vec<_>>(),
            DEFAULT_THUMB_LEVELS
        );
        assert_eq!(manifest.levels[0].width, 128);
        assert_eq!(manifest.levels[0].height, 64);
        assert_eq!(manifest.levels[4].width, 2048);
        assert_eq!(manifest.levels[4].height, 1024);
        assert_eq!(manifest.hash.algorithm, "sha256");
        assert_eq!(manifest.source_identity.kind, "local-file");
        assert_eq!(manifest.source_identity.cache_key, manifest.cache_key);
        assert_eq!(
            manifest.canonical_path,
            manifest.source_identity.canonical_path
        );
        assert_eq!(
            manifest.source_size_bytes,
            manifest.source_identity.size_bytes
        );
        assert_eq!(
            manifest.source_last_modified_ms,
            manifest.source_identity.last_modified_ms
        );

        let cache_root = fs::canonicalize(temp.path().join("cache")).unwrap();
        for level in &manifest.levels {
            assert_eq!(level.filename, format!("{}.png", level.max_side));
            assert_eq!(level.mime_type, "image/png");
            assert!(level.size_bytes > 0);
            assert!(level.src.starts_with("local-media:"));
            let level_path = Path::new(&level.path);
            assert!(level_path.exists());
            assert!(level_path.starts_with(&cache_root));
        }
        assert!(Path::new(&manifest.manifest_path).starts_with(cache_root));
    }

    #[test]
    fn does_not_upscale_levels_unless_configured() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("small.png");
        save_test_image(&source, ImageFormat::Png, 64, 32);

        let no_upscale = process_batch(BatchRequest {
            cache_root: temp.path().join("cache-no-upscale"),
            items: vec![WorkItem {
                id: "small".into(),
                path: source.clone(),
            }],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![32, 128]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: false,
                format: ThumbnailFormat::Png,
            },
            max_concurrency: Some(1),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        })
        .expect("no-upscale batch");
        let levels = &no_upscale.results[0].manifest.as_ref().unwrap().levels;
        assert_eq!(
            (levels[0].max_side, levels[0].width, levels[0].height),
            (32, 32, 16)
        );
        assert_eq!(
            (levels[1].max_side, levels[1].width, levels[1].height),
            (128, 64, 32)
        );

        let allow_upscale = process_batch(BatchRequest {
            cache_root: temp.path().join("cache-upscale"),
            items: vec![WorkItem {
                id: "small".into(),
                path: source,
            }],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![128]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: true,
                format: ThumbnailFormat::Png,
            },
            max_concurrency: Some(1),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        })
        .expect("allow-upscale batch");
        let level = &allow_upscale.results[0].manifest.as_ref().unwrap().levels[0];
        assert_eq!((level.width, level.height), (128, 64));
    }

    #[test]
    fn source_identity_and_cache_key_are_stable_for_same_file() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("stable.png");
        save_test_image(&source, ImageFormat::Png, 80, 40);

        let request = BatchRequest {
            cache_root: temp.path().join("cache"),
            items: vec![
                WorkItem {
                    id: "first".into(),
                    path: source.clone(),
                },
                WorkItem {
                    id: "second".into(),
                    path: source,
                },
            ],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![128]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: false,
                format: ThumbnailFormat::Png,
            },
            max_concurrency: Some(1),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        };

        let response = process_batch(request).expect("batch response");
        let first = response.results[0].manifest.as_ref().unwrap();
        let second = response.results[1].manifest.as_ref().unwrap();
        assert_eq!(first.cache_key, second.cache_key);
        assert_eq!(first.cache_key, first.source_identity.cache_key);
        assert!(first.cache_key.starts_with("thumb-"));
        assert_eq!(first.canonical_path, second.canonical_path);
        assert_eq!(first.source_size_bytes, second.source_size_bytes);
        assert_eq!(
            first.source_last_modified_ms,
            second.source_last_modified_ms
        );
        assert_eq!(first.hash.hex, second.hash.hex);
        assert_eq!(first.levels[0].path, second.levels[0].path);
    }

    #[test]
    fn cache_outputs_are_confined_to_cache_root() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("image.png");
        save_test_image(&source, ImageFormat::Png, 80, 40);
        let cache_root = temp.path().join("cache");

        let response = process_batch(BatchRequest {
            cache_root: cache_root.clone(),
            items: vec![WorkItem {
                id: "asset".into(),
                path: source,
            }],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![128, 256]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: false,
                format: ThumbnailFormat::Webp,
            },
            max_concurrency: Some(1),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        })
        .expect("batch response");

        let canonical_cache_root = fs::canonicalize(cache_root).unwrap();
        let manifest = response.results[0].manifest.as_ref().unwrap();
        assert!(Path::new(&manifest.manifest_path).starts_with(&canonical_cache_root));
        for level in &manifest.levels {
            assert!(Path::new(&level.path).starts_with(&canonical_cache_root));
            assert_eq!(level.mime_type, "image/webp");
            assert_eq!(level.filename, format!("{}.webp", level.max_side));
        }
        assert!(confined_join(&canonical_cache_root, &["thumbs", "abc.png"]).is_ok());
        assert!(confined_join(&canonical_cache_root, &["..", "escape.png"]).is_err());
        assert!(confined_join(&canonical_cache_root, &["thumbs/../escape.png"]).is_err());
        assert!(confined_join(&canonical_cache_root, &["/escape.png"]).is_err());
    }

    #[test]
    fn partial_failure_does_not_fail_batch() {
        let temp = TempDir::new().expect("temp dir");
        let good = temp.path().join("good.png");
        let bad = temp.path().join("not-image.png");
        save_test_image(&good, ImageFormat::Png, 32, 32);
        fs::write(&bad, b"not an image").expect("bad fixture");

        let response = process_batch(BatchRequest {
            cache_root: temp.path().join("cache"),
            items: vec![
                WorkItem {
                    id: "good".into(),
                    path: good,
                },
                WorkItem {
                    id: "bad".into(),
                    path: bad,
                },
                WorkItem {
                    id: "missing".into(),
                    path: temp.path().join("missing.png"),
                },
            ],
            thumbnail: ThumbnailRequest {
                levels: Some(vec![128]),
                max_side: None,
                max_width: None,
                max_height: None,
                allow_upscale: false,
                format: ThumbnailFormat::Png,
            },
            max_concurrency: Some(2),
            max_decoded_pixels: 10_000,
            hash: HashAlgorithm::Blake3,
        })
        .expect("batch response");

        assert!(response.ok);
        assert_eq!(response.results.len(), 3);
        assert_eq!(
            response.results.iter().filter(|result| result.ok).count(),
            1
        );
        assert_eq!(
            response.results.iter().filter(|result| !result.ok).count(),
            2
        );
        assert!(response
            .results
            .iter()
            .find(|result| result.id == "good")
            .unwrap()
            .manifest
            .is_some());
    }

    #[test]
    fn decoded_pixel_guard_rejects_large_images_without_failing_batch() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("large.png");
        save_test_image(&source, ImageFormat::Png, 11, 11);

        let request = BatchRequest {
            cache_root: temp.path().join("cache"),
            items: vec![WorkItem {
                id: "too-large".into(),
                path: source,
            }],
            thumbnail: ThumbnailRequest::default(),
            max_concurrency: Some(1),
            max_decoded_pixels: 100,
            hash: HashAlgorithm::Sha256,
        };

        let response = process_batch(request).expect("batch response");
        assert!(response.ok);
        assert_eq!(response.results.len(), 1);
        assert!(!response.results[0].ok);
        let message = &response.results[0].error.as_ref().unwrap().message;
        assert!(message.contains("decoded pixel guard rejected image"));
    }

    #[test]
    fn confined_join_rejects_escape_segments() {
        let root = Path::new("/tmp/cache");
        assert!(confined_join(root, &["thumbs", "abc.png"]).is_ok());
        assert!(confined_join(root, &["..", "escape.png"]).is_err());
        assert!(confined_join(root, &["thumbs/../escape.png"]).is_err());
    }

    #[test]
    fn cli_json_round_trip_from_request() {
        let temp = TempDir::new().expect("temp dir");
        let source = temp.path().join("图像.png");
        save_test_image(&source, ImageFormat::Png, 10, 8);
        let request = serde_json::json!({
            "cacheRoot": temp.path().join("cache"),
            "maxConcurrency": 1,
            "thumbnail": { "levels": [6], "format": "png" },
            "items": [{ "id": "asset-1", "path": source }]
        });
        let parsed: BatchRequest = serde_json::from_value(request).expect("parse request");
        let response = process_batch(parsed).expect("batch response");
        let encoded = serde_json::to_string(&response).expect("serialize response");
        assert!(encoded.contains("asset-1"));
        assert!(encoded.contains("图像.png"));
        assert!(encoded.contains("cacheKey"));
        assert!(encoded.contains("levels"));
    }

    fn save_test_image(path: &Path, format: ImageFormat, width: u32, height: u32) {
        let image = ImageBuffer::from_fn(width, height, |x, y| {
            Rgba([(x % 255) as u8, (y % 255) as u8, ((x + y) % 255) as u8, 255])
        });
        DynamicImage::ImageRgba8(image)
            .save_with_format(path, format)
            .expect("save image fixture");
    }
}
