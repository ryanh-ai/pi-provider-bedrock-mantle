# pi-provider-bedrock-mantle

Pi extension for **OpenAI GPT-5.5/5.4 models and Codex on Amazon Bedrock** via the `bedrock-mantle` endpoint.

## Auth Priority

1. **`AWS_BEARER_TOKEN_BEDROCK`** env var → Simple Bearer token (no SigV4 needed)
2. **AWS SDK credential chain** → SigV4 signing (profile, env vars, SSO, instance role, etc.)

## Quick Start

```bash
# Install
cd pi-provider-bedrock-mantle
npm install
npm run build

# Run pi with the extension
pi -e ./pi-provider-bedrock-mantle
```

Then use `/model` and select `GPT-5.5 (Bedrock)` or `GPT-5.4 (Bedrock)`.

## Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock API key (skips SigV4) | — |
| `AWS_PROFILE` | AWS profile for credential chain | default |
| `AWS_REGION` | AWS region | `us-east-2` |
| `BEDROCK_MANTLE_REGION` | Explicit region override | — |

## Available Models

| Model ID | Name | Regions |
|----------|------|---------|
| `openai.gpt-5.5` | GPT-5.5 | us-east-2 |
| `openai.gpt-5.4` | GPT-5.4 | us-east-2, us-west-2 |
| `openai.gpt-oss-120b` | GPT-OSS 120B | us-east-2, us-west-2 |
| `openai.gpt-oss-20b` | GPT-OSS 20B | us-east-2, us-west-2 |

## Image Handling

Normal user image inputs are passed through to `bedrock-mantle` unchanged.

`bedrock-mantle` currently does not accept images directly inside OpenAI Responses `function_call_output` / Pi `toolResult` messages. To keep tool images usable, this provider rewrites outgoing context in memory before each request:

1. Images in adjacent `toolResult` messages are replaced with text placeholders that include the image source name when available.
2. After the adjacent tool-result block, the provider injects a synthetic user message containing the original image attachment(s).
3. The injected user text tells the model to treat those attachments as the image output from the immediately preceding tool calls.

This rewrite is provider-local: it changes the outgoing Bedrock payload but does **not** modify the Pi session log.

If Pi's `read` tool cannot resize an image below Pi's inline image limit, it may return only a text fallback such as `[Image omitted: could not be resized below the inline image size limit.]`. In that case there is no image block for this provider to relocate.

## Examples

### With AWS Profile (SigV4)

```bash
AWS_PROFILE=fmevals-private pi -e ./pi-provider-bedrock-mantle
```

### With Bedrock API Key

```bash
AWS_BEARER_TOKEN_BEDROCK=your-api-key pi -e ./pi-provider-bedrock-mantle
```

### Custom Region

```bash
BEDROCK_MANTLE_REGION=us-west-2 pi -e ./pi-provider-bedrock-mantle
```
