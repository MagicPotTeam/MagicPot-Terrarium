# AI Video Generation Quick App

This document describes the built-in **AI Video Generation** Quick App, the provider profiles it expects, and the request fields MagicPot currently sends. The capability notes below are based on the current MagicPot implementation plus the public provider pages checked during this update:

- Kling text-to-video: <https://kling.ai/document-api/apiReference/model/textToVideo>
- Kling image-to-video: <https://kling.ai/document-api/apiReference/model/imageToVideo>
- Volcengine / BytePlus Seedance video task API: <https://www.volcengine.com/docs/82379/1520757> and LAS operator reference <https://www.volcengine.com/docs/6492/2165104>

Always confirm model-specific limits in your provider console before production use. Both Kling and Seedance gate some fields by model version, mode, account region, and enterprise enablement.

## Scope

The Quick App submits asynchronous video-generation tasks through an LLM API profile and polls until the provider returns a terminal result or MagicPot times out. It supports:

- **Kling** text-to-video and image-to-video.
- **Volcengine / BytePlus Seedance** text-to-video and multimodal image/video/audio-to-video content generation.

No local ComfyUI video backend is wired to this Quick App. It uses cloud provider APIs and requires provider credentials.

## Built-in Quick App routing

The video workspace is a built-in Quick App with key `~builtin/video-generation`. It is not a normal QApp configuration file and must not be loaded through `svcQApp.getQAppCfg`. `QAppMenu` selects the built-in key and `SidePanel` renders `VideoGenerationWorkspace` directly for that key.

## Provider profile setup

Create the profile in **Settings** under either **Quick App API** or **Agent Threads**. Profiles are considered video-capable when the profile is runnable and has video provider/model information.

### Kling

Recommended settings:

| Field | Value |
| --- | --- |
| Capability / Model use | `Video Generation` |
| Video Provider | `Kling` |
| Base URL | `https://api-beijing.klingai.com` |
| Model name | A Kling video model, for example `kling-v3` |
| API key | Kling **AccessKey ID** |
| API secret | Kling **AccessKey Secret** |

MagicPot signs a short-lived HS256 JWT from the AccessKey ID and SecretKey, then calls:

- `POST {base_url}/v1/videos/text2video` when no image attachment is supplied.
- `POST {base_url}/v1/videos/image2video` when an image attachment is supplied.
- `GET {same endpoint}/{task_id}` while polling.

### Volcengine / BytePlus Seedance

Recommended settings:

| Field | Value |
| --- | --- |
| Capability / Model use | `Video Generation` |
| Video Provider | `Volcengine / BytePlus Seedance` |
| Base URL | `https://ark.cn-beijing.volces.com/api/v3` |
| Model name | A Seedance video model, for example `doubao-seedance-1-0-pro-250528` |
| API key | Volcengine / BytePlus Bearer API key |
| API secret | Not used |

MagicPot normalizes a base URL ending in `/contents/generations/tasks` back to the API root, then calls:

- `POST {base_url}/contents/generations/tasks` to create the async task.
- `GET {base_url}/contents/generations/tasks/{task_id}` while polling.

## Workspace UI

The built-in workspace exposes:

- Provider/profile selection from video-capable Quick App API and Agent Thread profiles.
- Prompt, aspect ratio, duration, watermark, callback URL, request preview, and generated result handling.
- Asset slots: **First frame**, **Last frame**, **Reference image**, **Reference video**, and **Reference audio**.
- Kling controls: mode, sound, camera preset, simple six-axis camera values, CFG scale, external task ID, and Advanced JSON.
- Seedance controls: resolution, image role, generate/use audio, return last frame, frames, callback URL, adaptive duration, and Advanced JSON.
- Advanced JSON request passthrough. The JSON object is merged into `videoGenerationOptions` and then into provider request bodies. Treat this as a power-user escape hatch for fields not yet represented by typed controls.
- Request JSON preview. The preview is for inspection only; the main process still builds and validates the final provider request.

## Capability matrix

### Kling

| MagicPot option / UI | Provider field | Notes |
| --- | --- | --- |
| Model name | `model_name` | Uses the selected profile model, for example `kling-v3`. |
| Prompt | `prompt` | Omitted only when empty. Official prompt limit varies; Kling docs list 2500 chars for prompt/negative prompt. |
| First frame / Reference image | `image` | First image attachment. Data URLs are stripped to raw base64 before sending. |
| Last frame | `image_tail` | Second image attachment. Official docs say at least one of `image` or `image_tail` is required for image-to-video; MagicPot requires a leading image before `image_tail` in UI. |
| Aspect ratio | `aspect_ratio` | Text-to-video only. `16:9`, `9:16`, `1:1`; defaults to `16:9`. |
| Duration | `duration` | `3` through `15` seconds. Omitted if outside this set. |
| Negative prompt | `negative_prompt` | Sent when non-empty. |
| CFG scale | `cfg_scale` | Number from `0` to `1`; Kling docs note v2.x models may not support this field. |
| Mode | `mode` | `std`, `pro`, `4k`. Model/version support varies. |
| Sound | `sound` | `on`, `off`. Model/action support varies. |
| Camera preset | `camera_control.type` | `down_back`, `forward_up`, `right_turn_forward`, `left_turn_forward`, or omitted. |
| Simple six-axis camera | `camera_control: { type: "simple", config }` | Axes: `horizontal`, `vertical`, `pan`, `tilt`, `roll`, `zoom`; values `-10..10`. Kling docs say only one axis should be non-zero. MagicPot validates range but does not enforce the one-non-zero rule, because advanced users may intentionally test provider behavior. |
| Multi-shot | `multi_shot`, `shot_type`, `multi_prompt` | Exposed via Advanced JSON / option passthrough. Official docs require `shot_type` when multi-shot is enabled and support up to 6 storyboard prompts. |
| Element references | `element_list` | Exposed via Advanced JSON / option passthrough. Official support varies by model; element and voice lists are mutually exclusive in Kling docs. |
| Voice references | `voice_list` | Exposed via Advanced JSON / option passthrough. Official docs allow up to 2 voices and require `sound=on` when prompt references voice IDs. |
| Motion brush | `static_mask`, `dynamic_masks` | Exposed via Advanced JSON / option passthrough. Official docs restrict this to compatible image-to-video modes and up to 6 dynamic mask groups. |
| Watermark | `watermark_info.enabled` | Boolean. |
| Callback URL | `callback_url` | Public `http(s)` URL only; local/private hosts are rejected before submission. |
| External task ID | `external_task_id` | Kling custom task ID. |
| Request override | `requestOverride` | Programmatic only. Merged after typed options and can override any request body field. |

Kling caveats:

- `image_tail`, `dynamic_masks/static_mask`, and `camera_control` can be mutually exclusive in provider-side validation for some image-to-video modes.
- MagicPot emits metadata warnings for known risky combinations (for example sound on image-to-video, camera control on text-to-video, multi-shot without `shot_type="multi"`), but provider-side validation remains authoritative.
- Non-image asset slots are ignored for Kling.

### Volcengine / BytePlus Seedance

| MagicPot option / UI | Provider field | Notes |
| --- | --- | --- |
| Model name | `model` | Uses the selected profile model, for example `doubao-seedance-1-0-pro-250528`. |
| Prompt | `content[]` text item | Omitted only when empty. |
| First frame / Last frame / Reference image | `content[]` image items | Each image is sent as `type: image_url`, `image_url.url`, and a role. |
| Image role | image item `role` | `first_frame`, `last_frame`, `reference_image`; defaults to slot role. Manual role override is allowed only for a single image in the UI. |
| Reference video | `content[]` video item | Sent as `type: video_url`, `video_url.url`, role `reference_video`. UI requires a public `http(s)` or provider `asset://` URL. |
| Reference audio | `content[]` audio item | Sent as `type: audio_url`, `audio_url.url`, role `reference_audio`. UI requires a public `http(s)` or provider `asset://` URL. |
| Aspect ratio | `ratio` | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive`. Defaults to `adaptive` when an image is present, otherwise `16:9`. |
| Duration | `duration` | `2` through `12` seconds, or `-1` for adaptive/auto where model supports it. |
| Duration mode | `durationMode` | UI records `fixed` vs `adaptive`; the provider request uses `duration`. |
| Frames | `frames` | Optional integer in `[29, 289]` matching `25 + 4n`. Frames override duration provider-side. |
| Resolution | `resolution` | `480p`, `720p`, `1080p`; model/reference support varies. |
| Generate/use audio | `generate_audio` | Boolean. Official docs mark support as model-specific, e.g. Seedance 1.5 pro / Seedance 2.0 series. |
| Return last frame | `return_last_frame` | Boolean; provider can return `last_frame_url` for continuation workflows. |
| Callback URL | `callback_url` | Public `http(s)` URL only; local/private hosts are rejected before submission. |
| Watermark | `watermark` | Boolean; defaults to `false`. |
| Advanced JSON | request body merge | Allows fields such as `seed`, `camera_fixed`, `execution_expires_after`, `draft`, `service_tier`, or custom `content` shapes when the selected model supports them. |
| Request override | `requestOverride` | Programmatic only. Merged after typed options and can override any request body field. |

Seedance caveats:

- MagicPot does not map `externalTaskId` to Seedance because the public task API docs checked here do not expose `external_task_id` for Seedance video generation. Use provider-supported correlation fields through Advanced JSON only when documented for your endpoint.
- `negativePrompt` is accepted by the shared option type but is not mapped into Seedance requests by the current client.
- If Advanced JSON contains a `content` array, it can replace the UI-generated `content` array.
- Model-specific support for adaptive duration, 1080p, audio generation, draft mode, frames, camera-fixed, and reference roles varies.

## Image and URL security restrictions

MagicPot validates media before sending it to video providers:

- Allowed image inputs:
  - Public `http://` or `https://` image URLs.
  - `data:image/png;base64,...`, `data:image/jpeg;base64,...`, or `data:image/jpg;base64,...` up to **10 MB decoded image data**.
  - Seedance only: official `asset://...` image URLs are allowed for non-UI callers.
- Allowed Seedance video/audio references:
  - Public `http://` or `https://` URLs.
  - Volcengine `asset://...` URLs.
- Blocked inputs:
  - Local file paths.
  - `file://`, `blob:`, `local-media:`, and other non-http(s) URLs.
  - Private or local HTTP(S) hosts such as `localhost`, `*.localhost`, `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, link-local IPv6, and unique-local IPv6.
  - Data URL images other than PNG/JPEG, or PNG/JPEG data URLs over the 10 MB decoded limit.

These restrictions prevent accidentally sending local-only resources or intranet URLs to cloud providers. If you need to use a local image, select it in the Quick App UI so MagicPot converts it to an allowed data URL. For Seedance video/audio references, upload the media to a public/provider-supported asset store first.

## Polling, results, and URL expiry

- MagicPot polls every **5 seconds** by default.
- MagicPot gives up after **10 minutes** and reports a timeout.
- On success, the first returned public video URL is attached as `video/mp4` and shown in the Quick App result card.
- Volcengine LAS docs state generated video URLs and `last_frame_url` are cleaned up after **24 hours**. Treat all provider result URLs as temporary signed URLs and persist them promptly if you need long-term access.
- MagicPot does not currently mirror provider video files into durable storage automatically.

## Troubleshooting

### No video model appears in the Quick App

Check that the profile is configured as a runnable video profile:

- Capability / model use is `Video Generation` or the provider/model/base URL clearly identify Kling or Seedance.
- Kling profiles have both AccessKey and SecretKey.
- Seedance profiles have an API key.
- Base URL and model name are not empty.
- The profile is under **Quick App API** or **Agent Threads** settings.

### `QApp ~builtin/video-generation not found`

This means the built-in key was accidentally routed through normal QApp config loading. The video Quick App must render `VideoGenerationWorkspace` directly and must not call `svcQApp.getQAppCfg` for `~builtin/video-generation`.

### `Unable to create an LLM client`

The selected profile is not runnable. Verify credentials, base URL, model name, provider, and that it is not configured as a local call type.

### Image or reference URL rejected before submission

Use PNG/JPEG for image data URLs, keep data URLs under 10 MB decoded size, and avoid local/private URLs. For Seedance video/audio references, use a public HTTPS URL or provider `asset://` URL; local files are rejected because the provider cannot fetch them.

### Provider returns 401/403 or authentication errors

- Kling: verify AccessKey ID and SecretKey. MagicPot generates a JWT locally; incorrect system time can also cause token validity problems.
- Seedance: verify the Bearer API key and that the key has access to the selected model/region.
- Confirm the base URL matches the provider account/region you intend to use.

### Task fails with provider validation errors

Reduce to a minimal request: prompt only, default duration, default aspect ratio, no audio, no camera control, no 4K/pro mode, no reference image. Then re-enable options one by one. Some model versions may not support every parameter exposed by MagicPot.

### Task times out

MagicPot stops polling after 10 minutes. Check the provider console for the task status, try a shorter duration/lower resolution, or retry later if the provider queue is slow.

### Completed task has no video URL

MagicPot searches common response fields for provider video URLs, including `video_url`, `videoUrl`, `result_url`, and `resultUrl` in known result containers. If the provider response shape changed, the task may have succeeded but MagicPot cannot find the URL. Capture the provider task ID from logs and compare the response with the provider docs.

### Download or preview fails later

The result URL may have expired or require the same account/session context. Regenerate the video or retrieve it from the provider console if available.
