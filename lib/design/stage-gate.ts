/** DIR §5.2 — Design Summary approval ≠ implementation authorization */
export type ProjectStage = {
  lifecycle_stage: string;
  summary_status: string | null;
  implementation?: {
    projectId: string; customerId: string; approvedDirHash: string;
    consentProjectId: string; consentCustomerId: string; consentDirHash: string;
    approvedDir: boolean; expiresAt: number; revoked: boolean;
  };
};

export function canAuthorizeAgenticImplementation(project: ProjectStage): boolean {
  if (project.summary_status !== "approved") return false;
  const c = project.implementation;
  if (!c || !c.approvedDir || c.revoked || c.expiresAt <= Date.now()) return false;
  return Boolean(c.projectId && c.customerId && /^[a-f0-9]{64}$/.test(c.approvedDirHash)) &&
    c.projectId === c.consentProjectId && c.customerId === c.consentCustomerId &&
    c.approvedDirHash === c.consentDirHash;
}

export function canStartDesignSummaryReview(project: ProjectStage): boolean {
  return project.lifecycle_stage === "design_discussion";
}

export function isDesignSummaryApproved(project: ProjectStage): boolean {
  return project.summary_status === "approved";
}

/** BDD_F04_01: block agentic authorization without approved summary */
export function denyAgenticWithoutApprovedSummary(project: ProjectStage): boolean {
  return !isDesignSummaryApproved(project);
}
