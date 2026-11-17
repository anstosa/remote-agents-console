# Saved accounts and API keys

Global settings lists saved Codex accounts. **Add account** supports ChatGPT
device login or an OpenAI API key. Selecting an account changes the active
credentials; **Rename** changes only its local display name. Names are trimmed,
limited to 120 characters, and must not contain control characters. Renames
survive reloads, duplicate account additions, and re-login. The provider email
remains visible under a custom account name.

The conversations list combines the default agent stores with every configured
agent account's store, including account-specific home or state-directory
overrides. Shared stores and duplicate conversations appear only once; existing
folder filters still apply. Saved Codex logins share the same history under
`CODEX_HOME`, so conversations are not restricted to the active login. Listing
history does not switch accounts or change credentials. **Resume** opens the
selected conversation using the currently selected account, not the account that
originally created it. Resuming does not select a saved account or restore old
credentials.
History stored only in a different state directory stays visible, but cannot
resume until the current runtime can read it. The console checks availability
before replacing an agent; it does not copy transcripts or credentials.

## API-key spending

API-key rows show **Spent today** and **Spent this week** in US dollars from the
[OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs),
not token-price estimates. Today starts at midnight UTC and the calendar week
starts Monday at midnight UTC. Totals cover all provider-reported usage attributed
to the mapped key, including usage outside this console. Reporting can be delayed;
these are reported costs, not an instantaneous meter or final invoice. Results
are cached briefly; reopen settings to refresh them.

An ordinary API key cannot read organization billing. Configure the following
optional variables in the server's ignored `.env`:

```dotenv
RAC_OPENAI_ADMIN_KEY=your-organization-admin-key
RAC_OPENAI_API_KEY_IDS='{"account-2":"key_example"}'
```

- `RAC_OPENAI_ADMIN_KEY` is an OpenAI **Admin API key** for the organization
  containing the mapped keys. It is privileged: provision it only on a trusted
  server, do not paste it into the console's ordinary API-key form, and do not
  commit it. The console uses it only for read-only cost queries and never
  returns it to browsers or passes it to agent processes.
- `RAC_OPENAI_API_KEY_IDS` is a JSON object mapping each local saved account ID
  (the filename stem of its `accounts/<id>.auth.json` under `CODEX_HOME`) to its
  verified OpenAI API-key ID. Use the provider's key ID, **not the secret key**.
  [OpenAI's project API-key listing](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects/subresources/api_keys/methods/list)
  exposes IDs and redacted values. Verify the mapping against the correct project
  and key; do not guess from a display name or an ambiguous redacted match.
- All mapped keys must belong to that admin key's organization. If credentials
  are externally replaced or a slot is reused for a different key, update the
  mapping. Renaming a display label does not require a mapping change.

After configuration, run `docker compose up -d --build` from the current checkout
and verify `docker compose ps`. Non-Compose installations should restart their
existing server service with the updated environment.

Unconfigured keys show **Unavailable**, not `$0.00`. Provider errors, rejected
billing access, malformed responses, and incomplete queries also show
**Unavailable**. A successful query with no reported charges shows `$0.00`.
ChatGPT subscription accounts keep their existing rate-limit display and do not
use the billing integration.
