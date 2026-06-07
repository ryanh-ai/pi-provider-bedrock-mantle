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
