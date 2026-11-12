/** The Worker answers a write first and checks achievements afterwards
 * (`context.waitUntil`). Tests read the database right after a response, so
 * the compiled test artifact waits for that deferred work before it answers.
 * Only the artifact is changed; the production Worker never waits. */
export function settleDeferred(script: string): string {
  const exported = /export\s*\{\s*(\w+)\s+as\s+default\s*\};?\s*$/;
  const match = script.match(exported);
  if (!match) throw new Error('Worker default export was not found');
  return `${script.replace(exported, '')}
const settled_default = { ...${match[1]}, async fetch(request, env, context) {
  const pending = [];
  const response = await ${match[1]}.fetch(request, env, { waitUntil: promise => { pending.push(promise); }, passThroughOnException: () => context?.passThroughOnException?.() });
  await Promise.all(pending);
  return response;
} };
export { settled_default as default };`;
}
