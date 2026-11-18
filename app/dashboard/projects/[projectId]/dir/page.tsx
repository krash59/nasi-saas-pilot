import DirApproval from "./DirApproval";
import StoryAcceptance from "./StoryAcceptance";
import Link from "next/link";
import ReviseDesign from "../ReviseDesign";
import { notFound } from "next/navigation";
import { getProjectForCustomer } from "@/lib/design/repository";
import { getDirDraft } from "@/lib/design/dir-repository";
import type { DirDraftContent } from "@/lib/design/dir-draft";

export default async function DirPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = await getProjectForCustomer(projectId);
  if (!project) notFound();
  const draft = await getDirDraft(projectId);
  const content = draft?.content as DirDraftContent | undefined;
  return <main style={{ maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
    <Link href={`/dashboard/projects/${projectId}/summary`}>Back to Design Summary</Link>
    <h1>DIR Draft</h1>
    <p>Design version {project.design_version}</p>
    {content ? <>
      <p>Status: <strong>{draft!.status === "approved" ? "Approved by customer" : "AI_DRAFT — awaiting customer review"}</strong></p>
      <p>{content.governance}</p>
      <p>Source: customer-approved Design Summary, {String(draft!.source_approved_at)}</p>
      {content.sections.map(section => <section key={section.key}>
        <h2>{section.title}</h2><p style={{ whiteSpace: "pre-wrap" }}>{section.content}</p>
      </section>)}
      {draft!.status === "approved" ? <><p>Design approved at {String(draft!.approved_at)}.</p><StoryAcceptance projectId={projectId} content={content} /></> : <DirApproval projectId={projectId} content={content} />}
      <ReviseDesign projectId={projectId} />
    </> : <p>No DIR draft yet. Approve your Design Summary, then generate a draft from the summary page.</p>}
  </main>;
}
