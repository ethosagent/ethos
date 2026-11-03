---
title: "Run Ethos on AWS Bedrock: IAM, config and capabilities"
description: "Grant the Bedrock IAM permission, set provider, model and region in config.yaml, and check what the Bedrock provider supports."
kind: how-to
audience: user
time: "5 min"
updated: 2026-11-03
---

## Task

Grant the identity from the credential step permission to call Bedrock, point `~/.ethos/config.yaml` at Bedrock, and confirm a turn streams.

## Result

`ethos chat` streams tokens from Bedrock, and you know which capabilities the Bedrock provider lacks compared with `provider: anthropic`.

## Prereqs

- Complete [steps 1-2](../use-aws-bedrock.md): you have the model id and a credential path chosen.
- Write access to `~/.ethos/config.yaml`.

## Steps

### 3. Grant the IAM permission

Ethos calls Bedrock's `ConverseStream` operation. The action is `bedrock:InvokeModelWithResponseStream`, and it is the only Bedrock action Ethos needs.

Attach the [Bedrock inference role](../../reference/aws-iam-policies.md#bedrock-inference-role) policy to whichever identity step 2 resolves — the instance profile, the task role, the IRSA service-account role, the SSO permission set, or the IAM user behind the static key pair.

### 4. Point the config at Bedrock

The wizard covers it. `ethos setup` lists **AWS Bedrock**, skips the API-key prompt, and asks for the model id as free text — Bedrock ids are account- and region-specific, so there is no list to pick from.

```bash
ethos setup
```

To hand-edit instead, `~/.ethos/config.yaml` needs three keys:

```yaml
provider: bedrock
model: us.anthropic.claude-sonnet-4-6
region: us-west-2
personality: researcher
```

Omit `apiKey` — Bedrock authenticates every request with an AWS SigV4 signature, not a bearer key.

| Key | Required | Default | Notes |
|---|---|---|---|
| `provider` | Yes | — | `bedrock`. |
| `model` | Yes | — | The id from step 1, verbatim, including the trailing `:0` version suffix. |
| `region` | No | `us-east-1` | The Bedrock runtime endpoint region. There is no `AWS_REGION` fallback — set it here when you are not on `us-east-1`. |
| `awsProfile` | No | — | Named AWS profile for the credential chain. Ignored when static keys are configured. |

In a [fallback chain](../configure-providers.md), `region` and `awsProfile` are per-entry too: `providers.0.region`, `providers.0.awsProfile`.

Static `accessKeyId` / `secretAccessKey` / `sessionToken` are deliberately **not** config keys. The secret store is the only supported home for them — see step 2, Option B.

### What the Bedrock provider supports

The Bedrock provider declares a narrower capability set than the same model reached through Anthropic directly. Check it before you move a production [personality](../../../getting-started/glossary.md#personality) (a directory of files deciding an agent's tools, memory, and model) over.

| Capability | Bedrock provider | What it means |
|---|---|---|
| Streaming | Yes | Tokens arrive incrementally, as on every other provider. |
| Tool calling | Yes | Personality toolsets work unchanged. |
| Prompt caching | No | Every turn re-sends the full prefix and is billed for it. The largest cost difference against `provider: anthropic`. |
| Extended thinking | No | A personality configured for thinking gets ordinary completions. |
| Vision — images | Yes | Image attachments reach the model. |
| Vision — documents | No | PDF and document attachments do not. |
| Token counting | Estimated | The usage line is an estimate, not a provider-reported count. |
| Context window | 200,000 tokens | Fixed by the provider. `contextWindow:` in `~/.ethos/config.yaml` is not read on this path. |

## Verify

Check the config, then run one turn:

```bash
ethos doctor
```

```
  ✓  Provider 'bedrock' is valid
```

```bash
ethos chat -q "respond with the single word 'ok'"
```

```
ok
```

A streamed `ok` means the model id, the credentials, and the IAM permission all resolved end-to-end.
## Troubleshoot

**`Bedrock API error 403: ... is not authorized to perform: bedrock:InvokeModelWithResponseStream`.** — The identity resolved, but the policy does not cover this model. Check the `Resource` ARNs in step 3. A `us.`-prefixed inference profile needs both the inference-profile ARN and the foundation-model ARNs it routes to.

**`Bedrock API error 400: ... don't have access to the model with the specified model ID`.** — Model access is not granted for this model in the region `region:` names. Request it in the Bedrock console under **Model access**, in that region; approval for some models is not instant.

**The cost in the usage line does not match the AWS bill.** — Ethos prices a turn by substring-matching the model id against its own rate table. A Bedrock id carrying a known family name (`us.anthropic.claude-sonnet-4-...` contains `claude-sonnet-4`) is priced at that family's public rate; an id with no match reports `$0.00` rather than a wrong number. Neither figure is read from Bedrock. AWS Cost Explorer is authoritative.

## See also

- [Run Ethos on AWS Bedrock](../use-aws-bedrock.md) — steps 1-2 and the credential troubleshooting.
- [AWS IAM policies for Ethos](../../reference/aws-iam-policies.md) -- the Bedrock inference policy and the Secrets Manager policies, in one place.
