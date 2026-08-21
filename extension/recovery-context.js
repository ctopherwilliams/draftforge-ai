export async function recoverExactDraftRoomContext({
  draftLeagueId,
  teamId,
  roomTabId,
  findContext,
  reloadTab,
  waitForContext,
}) {
  let context = null;
  try {
    context = await findContext(draftLeagueId, roomTabId);
  } catch {
    context = null;
  }

  if (context?.inDraftRoom === true && Number(context.teamId) === Number(teamId)) {
    return { context, reloadedRoom: false };
  }

  await reloadTab(roomTabId);
  context = await waitForContext(draftLeagueId, Number(teamId), roomTabId);
  return { context, reloadedRoom: true };
}
