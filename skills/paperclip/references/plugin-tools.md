# Plugin Tools

Plugins can give you tools, for example the Azure DevOps plugin's `ado_get_work_item`. They are **not** in your own tool list, so a tool search will not find them: you call them through two Paperclip API routes, and no others. Do not guess other plugin routes (`/api/plugins/<id>/invoke/...`, `/api/plugins/<id>/actions/...`, `/api/mcp/...`); they are not for tools.

1. **List** them once per run, before the first call: `GET /api/plugins/tools`. Each entry has `name`, `description` and `parametersSchema`. Only the tools you may use are listed. `name` is namespaced as `<pluginId>:<tool>`, for example `chimera.plugin-ado:ado_get_work_item`; always call a tool by that full name. An empty list means no plugin tools are available to you: say so in your report rather than working around it.
2. **Call** one with `POST /api/plugins/tools/execute` and the body `{"tool": "<full name>", "parameters": {...}}`. `parameters` must match the tool's `parametersSchema` (`{}` when it needs none). Leave out `runContext`: your run's own agent, run and company are used.

## With the `call_api` tool (Paperclip Runner)

If you have a `call_api` tool (it may be named `mcp__paperclip__call_api`), use it; you do not need `search_api` first:

- List: `call_api` with `{"operationId": "GET /api/plugins/tools"}`
- Call: `call_api` with `{"operationId": "POST /api/plugins/tools/execute", "body": {"tool": "chimera.plugin-ado:ado_get_work_item", "parameters": {"workItemId": 804}}}`

Pass `body` as a JSON object, not a string.

## With curl

Otherwise use `$PAPERCLIP_API_URL` and `$PAPERCLIP_API_KEY`:

```bash
plugin_tool() {  # usage: plugin_tool <full tool name> ['<parameters JSON>']
  local params="${2:-}"; [ -n "$params" ] || params='{}'
  curl -sS -X POST "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg tool "$1" --argjson params "$params" '{tool: $tool, parameters: $params}')"
}
plugin_tool chimera.plugin-ado:ado_get_work_item '{}'
```

## Results

The reply carries the tool's result: `content` (text for you), optional `data`, and `error` when the tool refused or failed; read `error` before assuming success, and fix the call or report the refusal word for word. An HTTP error with a `reasonCode` comes from Paperclip's tool policy rather than the plugin (for example the tool is not allowed for you); report it word for word. A write tool configured as ask first behaves as in "MCP Tool Approval Gates" in `SKILL.md`.
