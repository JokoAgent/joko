const INTERNAL_SERVICE_TERM = /\bOrchestrator\b/giu;

/** Converts the architecture-facing service name into the public Joko vocabulary. */
export function presentJokoServiceTerminology(value: string): string {
  const publicServiceTerm = /\p{Script=Han}/u.test(value) ? "Joko 服务" : "Joko service";
  return value
    .replace(/\bbundled Orchestrator\b/giu, "local Joko service")
    .replace(/\bmanaged Orchestrator service\b/giu, "local Joko service")
    .replace(/\bOrchestrator service node\b/giu, "Joko service node")
    .replace(/\bOrchestrator node\b/giu, "Joko node")
    .replace(/\bOrchestrator service\b/giu, "Joko service")
    .replace(/捆绑的 Orchestrator/gu, "本机 Joko 服务")
    .replace(/Orchestrator 服务节点/giu, "Joko 服务节点")
    .replace(/Orchestrator 服务/giu, "Joko 服务")
    .replace(/Orchestrator 节点/giu, "Joko 节点")
    .replace(INTERNAL_SERVICE_TERM, publicServiceTerm)
    .replace(/Joko 服务 (?=\p{Script=Han})/gu, "Joko 服务");
}
