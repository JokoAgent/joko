const card = message => ({
  callId: message.callId,
  html: '<p>Status is ready.</p><button data-joko-action="refresh">Refresh</button>',
  height: 180,
  state: "done"
});

joko.tools.register("show_status", async message => {
  message.signal.throwIfAborted();
  const published = await joko.card.update(card(message));
  return { ok: published.ok, result: { shown: published.ok } };
});

joko.onHostMessage(async event => {
  if (event.type !== "event" || event.name !== "card-action" || event.actionId !== "refresh") return;
  await joko.card.update({ ...card(event), html: '<p>Status refreshed.</p><button data-joko-action="refresh">Refresh</button>' });
});
