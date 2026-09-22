// Validate scripted model responses against the request contract. Explicit
// adversarial scenarios may name hidden tools, but ordinary fixtures cannot.
export function modelContractError(body, call, adversarial = false) {
  const names = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const forced = body.tool_choice?.function?.name ?? body.tool_choice?.name;
  if (body.tool_choice === "none" && call) return "tool_choice:none forbids a call";
  if (forced && call?.name !== forced) return `expected forced tool ${forced}`;
  if (body.tool_choice === "required" && !call) return "tool_choice:required needs a call";
  if (call && !adversarial && !names.includes(call.name)) return `undeclared tool ${call.name}`;
}
