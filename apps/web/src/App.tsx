import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AuditPage, GovernancePage, InspectionsEvcPage, IntelligenceQueuePage, RegistryPage, ReviewsPage } from "./Part4Pages";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

type Institution = {
  id: string;
  name: string;
  institutionType?: string;
};

type Requirement = {
  id: string;
  code: string;
  description: string;
  mandatory: boolean;
};

type Workflow = {
  id: string;
  category: string;
  version: number;
  active?: boolean;
  requirements?: Requirement[];
};

type Application = {
  id: string;
  applicationNumber?: string | null;
  status: string;
  academicYear: string;
  createdAt?: string;
  updatedAt?: string;
  institution?: { id: string; name: string };
  campus?: { id: string; name: string } | null;
  programme?: { id: string; name: string } | null;
  workflow?: { id: string; category: string; version: number } | null;
};

type UploadedDocument = {
  id: string;
  originalName: string;
  mimeType: string;
  status: string;
  processingState?: string;
  scanResult?: string;
  processingError?: string | null;
  processingWarnings?: string[] | null;
  checksumSha256?: string;
  version: number;
  uploadedAt: string;
  extractions?: any[];
};
function items<T>(data: any): T[] {
  return Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
}

function pretty(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
}

export default function App() {
  const [email, setEmail] = useState("admin@flowguard.local");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [role, setRole] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [campuses, setCampuses] = useState<any[]>([]);
  const [programmes, setProgrammes] = useState<any[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [tab, setTab] = useState("Overview");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [evidenceSelection, setEvidenceSelection] = useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobStatusFilter, setJobStatusFilter] = useState("");
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [matches, setMatches] = useState<any[]>([]);
  const [ingestionBatches, setIngestionBatches] = useState<any[]>([]);
  const [importSearch, setImportSearch] = useState("");
  const [selectedImportBatch, setSelectedImportBatch] = useState<any>(null);
  const [importInstitutionSelections, setImportInstitutionSelections] = useState<Record<string, string>>({});
  const [fieldCorrections, setFieldCorrections] = useState<Record<string, string>>({});
  const [findingNotes, setFindingNotes] = useState<Record<string, string>>({});


  const [institutionId, setInstitutionId] = useState("");
  const [campusId, setCampusId] = useState("");
  const [programmeId, setProgrammeId] = useState("");
  const [academicYear, setAcademicYear] = useState("2026-27");
  const [workflowId, setWorkflowId] = useState("");
  const [applicationSearch, setApplicationSearch] = useState("");
  const [applicationStatusFilter, setApplicationStatusFilter] = useState("");

  const [category, setCategory] = useState("NEW_INSTITUTION");
  const [version, setVersion] = useState("1");
  const [config, setConfig] = useState("{}");
  const [activateWorkflow, setActivateWorkflow] = useState(true);
  const [requirementCode, setRequirementCode] = useState("DOC_001");
  const [requirementDescription, setRequirementDescription] = useState("");
  const [requirementMandatory, setRequirementMandatory] = useState(true);
  const [requirementWorkflowId, setRequirementWorkflowId] = useState("");

  const [deficiencyCode, setDeficiencyCode] = useState("DOC_MISSING");
  const [deficiencyDescription, setDeficiencyDescription] = useState("");
  const [deficiencyResponses, setDeficiencyResponses] = useState<Record<string, string>>({});
  const [decisionOutcome, setDecisionOutcome] = useState("APPROVED");
  const [decisionAuthority, setDecisionAuthority] = useState("Authorised Review Authority");
  const [decisionReference, setDecisionReference] = useState("");

  async function request(path: string, init: RequestInit = {}, authToken = token) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...init.headers
      }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && authToken) {
      logout();
      setMessage("Your session expired. Sign in again to continue.");
      throw new Error("Your session expired. Sign in again to continue.");
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  async function refresh(authToken = token) {
    const [dash, inst, apps, flows, jobData, notificationData, batchData, campusData, programmeData] = await Promise.all([
      request("/dashboard/summary", {}, authToken),
      request("/institutions", {}, authToken),
      request("/applications", {}, authToken),
      request("/workflows", {}, authToken),
      request("/jobs", {}, authToken),
      request("/notifications", {}, authToken),
      request("/ingestion/batches", {}, authToken),
      request("/campuses", {}, authToken),
      request("/programmes", {}, authToken)
    ]);
    setSummary(dash);
    const institutionItems = items<Institution>(inst);
    setInstitutions(institutionItems);
    setCampuses(items<any>(campusData));
    setProgrammes(items<any>(programmeData));
    setApplications(items<Application>(apps));
    setWorkflows(items<Workflow>(flows));
    setJobs(items<any>(jobData));
    setNotifications(items<any>(notificationData));
    setUnreadNotifications(notificationData.unreadCount || 0);
    setIngestionBatches(items<any>(batchData));
    if (!institutionId && institutionItems[0]) setInstitutionId(institutionItems[0].id);
    if (!workflowId && items<Workflow>(flows)[0]) setWorkflowId(items<Workflow>(flows)[0].id);
    if (!requirementWorkflowId && items<Workflow>(flows)[0]) {
      setRequirementWorkflowId(items<Workflow>(flows)[0].id);
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const data = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      }, "");
      setToken(data.accessToken);
      setRole(data.user?.role || "");
      await refresh(data.accessToken);
      setMessage(`Signed in as ${data.user?.name || email}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to connect to API");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    setToken("");
    setRole("");
    setPassword("");
    setSummary(null);
    setInstitutions([]);
    setApplications([]);
    setWorkflows([]);
    setDetail(null);
    setDocuments([]);
    setCompliance(null);
    setEvidenceSelection({});
    setSelectedFile(null);
    setJobs([]);
    setNotifications([]);
    setUnreadNotifications(0);
    setMatches([]);
    setIngestionBatches([]);
    setSelectedImportBatch(null);
    setJobStatusFilter("");
    setImportSearch("");
    setCampuses([]);
    setProgrammes([]);
    setFieldCorrections({});
    setDeficiencyResponses({});
    setFindingNotes({});
    setEvidenceSelection({});
    setMessage("Signed out");
  }

  useEffect(() => {
    const onSessionExpired = () => logout();
    window.addEventListener("flowguard:session-expired", onSessionExpired);
    return () => window.removeEventListener("flowguard:session-expired", onSessionExpired);
  }, []);

  async function runTask(task: () => Promise<any>, success: string) {
    setBusy(true);
    setMessage("");
    try {
      await task();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadDocuments(applicationId: string) {
    const data = await request(`/applications/${applicationId}/documents`);
    setDocuments(items<UploadedDocument>(data));
  }

  async function processDocument(documentId: string) {
    if (!detail) return;

    await runTask(async () => {
      await request(`/documents/${documentId}/process`, {
        method: "POST"
      });
      await Promise.all([loadDocuments(detail.id), loadCompliance(detail.id), loadJobs()]);
    }, "Document processing queued. Its status will update when a worker completes the job.");
  }

  async function verifyExtraction(documentId: string, extractionId: string, verifiedValue: string) {
    if (!detail) return;

    await runTask(async () => {
      await request(
        `/documents/${documentId}/extractions/${extractionId}/verify`,
        { method: "POST", body: JSON.stringify({ verifiedValue }) }
      );
      await Promise.all([loadDocuments(detail.id), loadCompliance(detail.id)]);
    }, "Evidence field verified and reviewer audit recorded. Compliance evidence refreshed.");
  }

  async function loadJobs() {
    const data = await request("/jobs");
    setJobs(items<any>(data));
  }

  async function loadNotifications() {
    const data = await request("/notifications");
    setNotifications(items<any>(data));
    setUnreadNotifications(data.unreadCount || 0);
  }

  async function loadMatches(applicationId: string) {
    const data = await request(`/applications/${applicationId}/matches`);
    setMatches(items<any>(data));
  }

  async function refreshComplianceAnalysis() {
    if (!detail) return;
    await runTask(async () => {
      await request(`/applications/${detail.id}/compliance/refresh`, { method: "POST" });
      await loadJobs();
    }, "Compliance analysis queued. Refresh this application after the worker processes it.");
  }

  async function refreshApplicationMatches() {
    if (!detail) return;
    await runTask(async () => {
      await request(`/applications/${detail.id}/matches/refresh`, { method: "POST" });
      await loadJobs();
    }, "Potential matching queued for human review.");
  }

  async function downloadDocument(documentId: string, fileName: string) {
    await runTask(async () => {
      const response = await fetch(`${API}/documents/${documentId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Download failed (${response.status})`);
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(blobUrl);
    }, "Private document downloaded.");
  }

  async function markNotificationRead(id: string) {
    await runTask(async () => {
      await request(`/notifications/${id}/read`, { method: "POST" });
      await loadNotifications();
    }, "Notification marked as read.");
  }

  async function reviewFinding(id: string, status: string) {
    if (!detail) return;
    await runTask(async () => {
      await request(`/compliance-findings/${id}/review`, { method: "POST", body: JSON.stringify({ status, resolutionNotes: findingNotes[id] || undefined }) });
      await Promise.all([loadCompliance(detail.id), loadNotifications()]);
    }, "Finding review saved with an audit record.");
  }

  async function reviewMatch(id: string, status: string) {
    if (!detail) return;
    await runTask(async () => {
      await request(`/matches/${id}/review`, { method: "PATCH", body: JSON.stringify({ status }) });
      await loadMatches(detail.id);
    }, "Matching review saved. No records were merged.");
  }

  async function startSyntheticImport() {
    await runTask(async () => {
      const result = await request("/ingestion/fixtures", { method: "POST" });
      await refresh();
      setSelectedImportBatch(result.batch);
    }, "Synthetic fixture import queued; no real source is contacted.");
  }

  async function importLocalJson(file: File | null) {
    if (!file) return;
    await runTask(async () => {
      if (file.size > 900_000) throw new Error("JSON file must be smaller than 900 KB.");
      const content = JSON.parse(await file.text());
      const records = Array.isArray(content) ? content : content.records;
      if (!Array.isArray(records)) throw new Error("Choose a JSON array or an object with a records array.");
      const result = await request("/ingestion/local-records", { method: "POST", body: JSON.stringify({ sourceName: file.name.slice(0, 120), records }) });
      await refresh();
      setSelectedImportBatch(result.batch);
    }, "Validated local JSON queued; each proposed match or institution change requires manual review.");
  }

  async function openImportBatch(id: string) {
    await runTask(async () => {
      const data = await request(`/ingestion/batches/${id}`);
      setSelectedImportBatch(data);
    }, "Import batch loaded.");
  }

  async function reviewImportRecord(recordId: string, action: string) {
    if (!selectedImportBatch) return;
    await runTask(async () => {
      await request(`/ingestion/records/${recordId}/review`, { method: "PATCH", body: JSON.stringify({ action, ...(action === "LINK_EXISTING" ? { institutionId: importInstitutionSelections[recordId] } : {}) }) });
      const [batch] = await Promise.all([request(`/ingestion/batches/${selectedImportBatch.id}`), refresh()]);
      setSelectedImportBatch(batch);
    }, "Import record review saved.");
  }

  async function uploadDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!detail || !selectedFile) {
      setMessage("Select a document first.");
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData();
    formData.append("file", selectedFile);

    await runTask(async () => {
      const response = await fetch(
        `${API}/applications/${detail.id}/documents`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || `Upload failed (${response.status})`);
      }

      await Promise.all([loadDocuments(detail.id), loadCompliance(detail.id)]);
      setSelectedFile(null);
      form.reset();
    }, "Document uploaded and background processing queued. Review its scan and extraction status after the worker runs.");
  }
    async function loadCompliance(applicationId: string) {
    const data = await request(`/applications/${applicationId}/compliance`);
    setCompliance(data);
    return data;
  }

  async function linkRequirementEvidence(requirementId: string) {
    if (!detail) return;
    const documentId = evidenceSelection[requirementId];
    if (!documentId) {
      setMessage("Select a document before linking evidence.");
      return;
    }
    await runTask(async () => {
      await request(`/applications/${detail.id}/requirements/${requirementId}/evidence`, {
        method: "POST",
        body: JSON.stringify({ documentId })
      });
      setEvidenceSelection((prev) => ({ ...prev, [requirementId]: "" }));
      await Promise.all([loadCompliance(detail.id), loadDocuments(detail.id)]);
    }, "Evidence linked. Review extracted fields against the source; linking is not a compliance decision.");
  }

  async function unlinkRequirementEvidence(requirementId: string, documentId: string) {
    if (!detail) return;
    await runTask(async () => {
      await request(`/applications/${detail.id}/requirements/${requirementId}/evidence/${documentId}`, {
        method: "DELETE"
      });
      await Promise.all([loadCompliance(detail.id), loadDocuments(detail.id)]);
    }, "Evidence link removed.");
  }
async function openApplication(id: string) {
    await runTask(async () => {
      setCompliance(null);
      setDocuments([]);
      setEvidenceSelection({});
      setMatches([]);
      const data = await request(`/applications/${id}`);
      setDetail(data);
      await Promise.all([loadDocuments(id), loadCompliance(id), loadMatches(id)]);
      setTab("Application detail");
    }, "Application details loaded");
  }

  async function createApplication(event: FormEvent) {
    event.preventDefault();
    await runTask(async () => {
      const created = await request("/applications", {
        method: "POST",
        body: JSON.stringify({
          institutionId,
          campusId: campusId || null,
          programmeId: programmeId || null,
          academicYear,
          workflowId: workflowId || null
        })
      });
      await refresh();
      setDetail(await request(`/applications/${created.id}`));
      setTab("Application detail");
    }, "Application draft created");
  }

  async function submitApplication(id: string) {
    await runTask(async () => {
      await request(`/applications/${id}/submit`, { method: "POST" });
      await refresh();
      setDetail(await request(`/applications/${id}`));
    }, "Application submitted");
  }

  async function startReview(id: string) {
    await runTask(async () => {
      await request(`/applications/${id}/start-review`, { method: "POST" });
      await refresh();
      setDetail(await request(`/applications/${id}`));
    }, "Review started");
  }

  async function raiseDeficiency(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    await runTask(async () => {
      await request(`/applications/${detail.id}/deficiencies`, {
        method: "POST",
        body: JSON.stringify({ code: deficiencyCode, description: deficiencyDescription })
      });
      setDeficiencyDescription("");
      await refresh();
      setDetail(await request(`/applications/${detail.id}`));
    }, "Deficiency raised");
  }

  async function respondToDeficiency(id: string, responseText: string) {
    await runTask(async () => {
      await request(`/deficiencies/${id}/respond`, { method: "POST", body: JSON.stringify({ responseText }) });
      await refresh();
      setDetail(await request(`/applications/${detail.id}`));
    }, "Deficiency response submitted");
  }

  async function closeDeficiency(id: string) {
    await runTask(async () => {
      await request(`/deficiencies/${id}/close`, { method: "POST" });
      await refresh();
      setDetail(await request(`/applications/${detail.id}`));
    }, "Deficiency closed");
  }

  async function issueDecision(event: FormEvent) {
    event.preventDefault();
    if (!detail) return;
    await runTask(async () => {
      await request(`/applications/${detail.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          outcome: decisionOutcome,
          authority: decisionAuthority,
          ...(decisionReference.trim() ? { reference: decisionReference.trim() } : {})
        })
      });
      await refresh();
      setDetail(await request(`/applications/${detail.id}`));
    }, "Formal decision recorded");
  }

  async function createWorkflow(event: FormEvent) {
    event.preventDefault();
    await runTask(async () => {
      const parsedConfig = JSON.parse(config);
      if (!parsedConfig || Array.isArray(parsedConfig) || typeof parsedConfig !== "object") {
        throw new Error("Workflow config must be a JSON object");
      }
      await request("/workflows", {
        method: "POST",
        body: JSON.stringify({
          category: category.trim().toUpperCase(),
          version: Number(version),
          config: parsedConfig,
          active: activateWorkflow
        })
      });
      await refresh();
    }, "Workflow created");
  }

  async function createRequirement(event: FormEvent) {
    event.preventDefault();
    await runTask(async () => {
      await request(`/workflows/${requirementWorkflowId}/requirements`, {
        method: "POST",
        body: JSON.stringify({
          code: requirementCode,
          description: requirementDescription,
          mandatory: requirementMandatory
        })
      });
      setRequirementDescription("");
      await refresh();
    }, "Requirement added");
  }

  async function refreshCurrentApplication() {
    if (!detail) return;
    await runTask(async () => {
      const [, , , updated] = await Promise.all([loadDocuments(detail.id), loadCompliance(detail.id), loadMatches(detail.id), request(`/applications/${detail.id}`), loadJobs()]);
      setDetail(updated);
    }, "Application, document, analysis and job statuses refreshed.");
  }

  const navItems = ["Overview", "Institutions", "Registry", "Applications", "Workflows", "Requirements", "Reviews", "Inspections & EVC", "Approvals & obligations", "Document review", "Compliance findings", "Matching review", "Imports", "Jobs", "Notifications", "Audit history"];

  return (
    <main className="page fg-page">
      <nav className="nav">
        <div className="brand"><span className="mark">F</span> FlowGuard</div>
        <span className="nav-tag">AICTE APPROVAL INTELLIGENCE</span>
        {token && <button className="secondary fg-logout" onClick={logout}>Sign out</button>}
      </nav>

      {!token ? (
        <>
          <section className="hero">
            <p className="eyebrow">AICTE WORKFLOW & EVIDENCE PLATFORM</p>
            <h1>Compliance work.<br /><span>Under control.</span></h1>
            <p className="intro">Applications, evidence, deficiencies and decisions in one traceable workspace.</p>
          </section>
          <form className="panel login" onSubmit={login}>
            <h2>Workspace sign in</h2>
            <p className="muted">Connect to your FlowGuard development workspace.</p>
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
            <button disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
            {message && <p className="notice">{message}</p>}
            <p className="footnote">Use the admin password configured by your local database seed.</p>
          </form>
        </>
      ) : (
        <section className="fg-workspace">
          <div className="fg-welcome">
            <div>
              <p className="eyebrow">WORKSPACE / REGULATORY OPERATIONS</p>
              <h1>Approval operations</h1>
              <p className="muted">Track each application from draft through review and formal decision.</p>
            </div>
            <button className="secondary" disabled={busy} onClick={() => runTask(() => refresh(), "Workspace refreshed")}>
              Refresh data
            </button>
          </div>

          <div className="fg-nav">
            {navItems.map(item => (
              <button key={item} className={tab === item || (item === "Applications" && tab === "Application detail") ? "fg-nav-active" : ""} onClick={() => { setTab(item); if (item === "Notifications") void loadNotifications(); }}>
                {item}{item === "Notifications" && unreadNotifications > 0 ? ` (${unreadNotifications})` : ""}
              </button>
            ))}
          </div>

          {message && <div className="fg-message">{message}</div>}

          {tab === "Overview" && (
            <>
              <div className="stats fg-stats">
                {[
                  ["Institutions", summary?.institutions ?? institutions.length],
                  ["Applications", summary?.applications ?? applications.length],
                  ["Open deficiencies", summary?.openDeficiencies ?? 0],
                  ["Pending reviews", summary?.pendingReviews ?? 0],
                  ["Approvals expiring in 90 days", summary?.approvalsExpiringSoon ?? 0],
                  ["Documents awaiting processing", summary?.documentsAwaitingProcessing ?? 0],
                  ["Documents awaiting human review", summary?.documentsAwaitingHumanReview ?? 0],
                  ["Open/retrying jobs", summary?.failedJobs ?? 0]
                ].map(([label, value]) => (
                  <article className="stat" key={String(label)}>
                    <p>{label}</p><strong>{value}</strong><span>Current workspace</span>
                  </article>
                ))}
              </div>
              <div className="fg-grid">
                <section className="panel fg-panel">
                  <h2>Application stages</h2>
                  {!summary?.applicationStatuses?.length ? <p className="fg-empty">No applications are recorded yet.</p> : summary.applicationStatuses.map((item: any) => <div className="fg-row" key={item.status}><strong>{pretty(item.status)}</strong><span className="fg-pill">{item.count}</span></div>)}
                </section>
                <section className="panel fg-panel">
                  <h2>Open compliance findings</h2>
                  {!summary?.openFindingsBySeverity?.length ? <p className="fg-empty">No open findings recorded.</p> : summary.openFindingsBySeverity.map((item: any) => <div className="fg-row" key={item.severity}><strong>{pretty(item.severity)}</strong><span className="fg-pill">{item.count}</span></div>)}
                </section>
                <section className="panel fg-panel">
                  <h2>Recent applications</h2>
                  <p className="muted">Open an application to continue its lifecycle.</p>
                  <ApplicationList applications={applications.slice(0, 5)} onOpen={openApplication} />
                  <button onClick={() => setTab("Applications")}>View all applications</button>
                </section>
                <section className="panel fg-panel">
                  <h2>Workflow templates</h2>
                  <p className="muted">Active, versioned workflows available to new applications.</p>
                  {workflows.length === 0 ? <p className="fg-empty">No active workflows yet. Create one in Workflows.</p> : workflows.map(w => (
                    <div className="fg-row" key={w.id}>
                      <div><strong>{pretty(w.category)}</strong><p className="muted">Version {w.version} Ãƒâ€šÃ‚Â· {w.requirements?.length ?? 0} requirements</p></div>
                      <span className="fg-pill">Active</span>
                    </div>
                  ))}
                </section>
                <section className="panel fg-panel">
                  <h2>Recent authorized activity</h2>
                  {!summary?.recentActivity?.length ? <p className="fg-empty">No recorded activity yet.</p> : summary.recentActivity.map((event: any) => <div className="fg-row" key={event.id}><div><strong>{pretty(event.action)}</strong><p className="muted">{event.actor?.name || "System"} · {event.resourceType} · {new Date(event.createdAt).toLocaleString()}</p></div></div>)}
                  <button className="secondary" onClick={() => setTab("Audit history")}>Open audit history</button>
                </section>
              </div>
            </>
          )}

          {tab === "Institutions" && (
            <section className="panel fg-panel">
              <h2>Institutions</h2>
              <p className="muted">Institutions available to your signed-in tenant.</p>
              {institutions.length === 0 ? <p className="fg-empty">No institutions found. Add an institution through the institution API before creating applications.</p> : institutions.map(inst => (
                <div className="fg-row" key={inst.id}>
                  <div><strong>{inst.name}</strong><p className="muted">{inst.institutionType || "Institution"} Ãƒâ€šÃ‚Â· {inst.id}</p></div>
                  <button className="secondary" onClick={() => { setInstitutionId(inst.id); setTab("Applications"); }}>Create application</button>
                </div>
              ))}
            </section>
          )}

          {tab === "Registry" && <RegistryPage token={token} role={role} page={tab} onOpenApplication={openApplication} />}
          {tab === "Reviews" && <ReviewsPage token={token} role={role} page={tab} onOpenApplication={openApplication} />}
          {tab === "Inspections & EVC" && <InspectionsEvcPage token={token} role={role} page={tab} onOpenApplication={openApplication} />}
          {tab === "Approvals & obligations" && <GovernancePage token={token} role={role} page={tab} onOpenApplication={openApplication} />}
          {["Document review", "Compliance findings", "Matching review"].includes(tab) && <IntelligenceQueuePage token={token} role={role} page={tab} onOpenApplication={openApplication} />}
          {tab === "Audit history" && <AuditPage token={token} role={role} page={tab} onOpenApplication={openApplication} />}

          {tab === "Applications" && (
            <div className="fg-grid">
              <section className="panel fg-panel">
                <h2>Create application</h2>
                <p className="muted">Create a draft under an institution and academic year.</p>
                {institutions.length === 0 ? <p className="fg-empty">Create an institution first. This workspace currently has none.</p> : (
                  <form className="fg-form" onSubmit={createApplication}>
                    <label>Institution</label>
                    <select value={institutionId} onChange={e => setInstitutionId(e.target.value)} required>
                      {institutions.map(inst => <option key={inst.id} value={inst.id}>{inst.name}</option>)}
                    </select>
                    <label>Academic year</label>
                    <input value={academicYear} onChange={e => setAcademicYear(e.target.value)} minLength={4} maxLength={20} required />
                    <label>Campus (optional)</label>
                    <select value={campusId} onChange={e => setCampusId(e.target.value)}><option value="">No campus selected</option>{campuses.filter(item => item.institution?.id === institutionId || item.institutionId === institutionId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                    <label>Programme (optional)</label>
                    <select value={programmeId} onChange={e => setProgrammeId(e.target.value)}><option value="">No programme selected</option>{programmes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                    <label>Active workflow (optional)</label>
                    <select value={workflowId} onChange={e => setWorkflowId(e.target.value)}>
                      <option value="">No workflow selected</option>
                      {workflows.filter(w => w.active).map(w => <option key={w.id} value={w.id}>{pretty(w.category)} Ãƒâ€šÃ‚Â· v{w.version}</option>)}
                    </select>
                    <button disabled={busy}>Create draft</button>
                  </form>
                )}
              </section>
              <section className="panel fg-panel">
                <h2>Application register</h2>
                <div className="fg-grid"><div><label>Search</label><input value={applicationSearch} onChange={e => setApplicationSearch(e.target.value)} placeholder="Institution, number, campus or programme" /></div><div><label>Processing stage</label><select value={applicationStatusFilter} onChange={e => setApplicationStatusFilter(e.target.value)}><option value="">All stages</option>{["DRAFT","SUBMITTED","UNDER_REVIEW","DEFICIENCY_RAISED","RESUBMITTED","DECISION_ISSUED"].map(status=><option key={status}>{status}</option>)}</select></div></div>
                <ApplicationList applications={applications.filter(app => (!applicationStatusFilter || app.status === applicationStatusFilter) && JSON.stringify(app).toLowerCase().includes(applicationSearch.toLowerCase()))} onOpen={openApplication} />
              </section>
            </div>
          )}

          {tab === "Workflows" && (
            <div className="fg-grid">
              <section className="panel fg-panel">
                <h2>Create workflow version</h2>
                <p className="muted">Use a distinct category and version for each workflow definition.</p>
                {(["ADMIN", "REVIEWER"].includes(role)) && <form className="fg-form" onSubmit={createWorkflow}>
                  <label>Category (uppercase)</label>
                  <input value={category} onChange={e => setCategory(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} required />
                  <label>Version</label>
                  <input type="number" min="1" value={version} onChange={e => setVersion(e.target.value)} required />
                  <label>Config JSON</label>
                  <textarea rows={4} value={config} onChange={e => setConfig(e.target.value)} required />
                  <label className="fg-check"><input type="checkbox" checked={activateWorkflow} onChange={e => setActivateWorkflow(e.target.checked)} /> Activate this version</label>
                  <button disabled={busy}>Create workflow</button>
                </form>}
              </section>
              <section className="panel fg-panel">
                <h2>Workflow versions</h2>
                {workflows.length === 0 ? <p className="fg-empty">No active workflows.</p> : workflows.map(w => (
                  <article className="fg-workflow" key={w.id}>
                    <div className="fg-row">
                      <div><strong>{pretty(w.category)}</strong><p className="muted">Version {w.version}</p></div>
                      <span className="fg-pill">{w.active ? "Active" : "Inactive version"}</span>
                    </div>
                    <p className="muted">{w.requirements?.length ?? 0} linked requirements</p>
                    {w.requirements?.map(r => <div className="fg-requirement" key={r.id}><strong>{r.code}</strong> Ãƒâ€šÃ‚Â· {r.description} {r.mandatory && <span className="fg-required">Mandatory</span>}</div>)}
                  </article>
                ))}
              </section>
            </div>
          )}

          {tab === "Requirements" && (
            <div className="fg-grid">
              <section className="panel fg-panel">
                <h2>Add requirement</h2>
                <p className="muted">Attach a checklist item to a specific workflow version.</p>
                {workflows.length === 0 ? <p className="fg-empty">Create and activate a workflow first.</p> : ["ADMIN", "REVIEWER"].includes(role) ? (
                  <form className="fg-form" onSubmit={createRequirement}>
                    <label>Workflow version</label>
                    <select value={requirementWorkflowId} onChange={e => setRequirementWorkflowId(e.target.value)} required>
                      {workflows.map(w => <option key={w.id} value={w.id}>{pretty(w.category)} Ãƒâ€šÃ‚Â· v{w.version}</option>)}
                    </select>
                    <label>Requirement code</label>
                    <input value={requirementCode} onChange={e => setRequirementCode(e.target.value)} required />
                    <label>Description</label>
                    <textarea rows={4} value={requirementDescription} onChange={e => setRequirementDescription(e.target.value)} minLength={3} required />
                    <label className="fg-check"><input type="checkbox" checked={requirementMandatory} onChange={e => setRequirementMandatory(e.target.checked)} /> Mandatory requirement</label>
                    <button disabled={busy}>Add requirement</button>
                  </form>
                ) : <p className="fg-empty">You can review these workflow requirements; editing requires a reviewer role.</p>}
              </section>
              <section className="panel fg-panel">
                <h2>Requirements by workflow</h2>
                {workflows.map(w => (
                  <article className="fg-workflow" key={w.id}>
                    <strong>{pretty(w.category)} Ãƒâ€šÃ‚Â· v{w.version}</strong>
                    {(w.requirements || []).length === 0 ? <p className="muted">No requirements added.</p> : w.requirements?.map(r => (
                      <div className="fg-requirement" key={r.id}><strong>{r.code}</strong><p>{r.description}</p><span className={r.mandatory ? "fg-required" : "muted"}>{r.mandatory ? "Mandatory" : "Optional"}</span></div>
                    ))}
                  </article>
                ))}
              </section>
            </div>
          )}

          {tab === "Imports" && (
            <div className="fg-grid">
              <section className="panel fg-panel">
                <h2>Authorized data ingestion</h2>
                <p className="muted">The local demo uses clearly fictional records. No external service or AICTE endpoint is contacted.</p>
                {(["ADMIN", "REVIEWER"].includes(role)) && <button disabled={busy} onClick={startSyntheticImport}>Queue synthetic fixture</button>}
                <label htmlFor="local-json-import">Import an authorized local JSON file</label>
                {(["ADMIN", "REVIEWER"].includes(role)) && <input id="local-json-import" type="file" accept="application/json,.json" disabled={busy} onChange={event => { void importLocalJson(event.target.files?.[0] || null); event.currentTarget.value = ""; }} />}
                <p className="muted">Use a JSON array or <code>{'{ "records": [...] }'}</code>. Each record needs sourceRecordKey, name, institutionType, and may include address and promoterName. Max 500 records / 900 KB.</p>
                <h3>Import batches</h3>
                <label>Search batches</label><input value={importSearch} onChange={event => setImportSearch(event.target.value)} placeholder="Source or state" />
                {!ingestionBatches.filter(batch => JSON.stringify(batch).toLowerCase().includes(importSearch.toLowerCase())).length ? <p className="fg-empty">No import batches match this filter.</p> : ingestionBatches.filter(batch => JSON.stringify(batch).toLowerCase().includes(importSearch.toLowerCase())).map(batch => (
                  <article className="fg-deficiency" key={batch.id}>
                    <div className="fg-row"><strong>{batch.sourceName}</strong><span className="fg-status">{pretty(batch.status)}</span></div>
                    <p className="muted">{batch.totalRecords} source records · {batch.stagedRecords} staged · {batch.linkedRecords} linked/created</p>
                    <button className="secondary" onClick={() => openImportBatch(batch.id)}>Review records</button>
                  </article>
                ))}
              </section>
              <section className="panel fg-panel">
                <h2>{selectedImportBatch ? `Review ${selectedImportBatch.sourceName}` : "Import review queue"}</h2>
                {!selectedImportBatch ? <p className="fg-empty">Select a completed batch to review its staged records.</p> : !selectedImportBatch.records?.length ? <p className="fg-empty">Records are still being staged, or this batch is empty. Refresh data and open the batch again.</p> : selectedImportBatch.records.map((record: any) => {
                  const source = record.normalizedData || {};
                  const candidate = institutions.find(item => item.id === record.candidateInstitutionId);
                  return <article className="fg-deficiency" key={record.id}>
                    <div className="fg-row"><strong>{source.name || record.sourceRecordKey}</strong><span className="fg-status">{pretty(record.status)}</span></div>
                    <p className="muted">Synthetic key: {record.sourceRecordKey} · {pretty(source.institutionType || "OTHER")}</p>
                    {candidate && <p className="muted">Possible existing record: {candidate.name} ({Math.round((record.candidateScore || 0) * 100)}% rule similarity). Review manually; no automatic merge occurred.</p>}
                    {record.status === "NEEDS_REVIEW" && ["ADMIN", "REVIEWER"].includes(role) && <>
                      <label>Existing institution to link</label>
                      <select value={importInstitutionSelections[record.id] || record.candidateInstitutionId || ""} onChange={event => setImportInstitutionSelections(previous => ({ ...previous, [record.id]: event.target.value }))}>
                        <option value="">Choose existing institution</option>
                        {institutions.map(institution => <option key={institution.id} value={institution.id}>{institution.name}</option>)}
                      </select>
                      <div className="fg-actions">
                        <button disabled={busy || !(importInstitutionSelections[record.id] || record.candidateInstitutionId)} onClick={() => reviewImportRecord(record.id, "LINK_EXISTING")}>Link selected</button>
                        <button className="secondary" disabled={busy} onClick={() => reviewImportRecord(record.id, "CREATE_NEW")}>Create new institution</button>
                        <button className="secondary" disabled={busy} onClick={() => reviewImportRecord(record.id, "IGNORE")}>Ignore record</button>
                      </div>
                    </>}
                    {record.reviewNotes && <p className="muted">Review note: {record.reviewNotes}</p>}
                  </article>;
                })}
              </section>
            </div>
          )}

          {tab === "Jobs" && (
            <section className="panel fg-panel">
              <div className="fg-row"><div><h2>Background jobs</h2><p className="muted">Queue state, retries and sanitized failure summaries.</p></div><button className="secondary" onClick={() => runTask(loadJobs, "Job status refreshed.")}>Refresh jobs</button></div>
              <label>Filter by job state</label><select value={jobStatusFilter} onChange={event => setJobStatusFilter(event.target.value)}><option value="">All states</option>{["PENDING","RUNNING","RETRY","COMPLETED","DEAD_LETTER"].map(status=><option key={status}>{status}</option>)}</select>
              {!jobs.filter(job => !jobStatusFilter || job.status === jobStatusFilter).length ? <p className="fg-empty">No jobs match this state. Upload a document or queue an analysis to create a job.</p> : jobs.filter(job => !jobStatusFilter || job.status === jobStatusFilter).map(job => <article className="fg-deficiency" key={job.id}>
                <div className="fg-row"><strong>{pretty(job.type)}</strong><span className="fg-status">{pretty(job.status)}</span></div>
                <p className="muted">Attempts {job.attempts}/{job.maxAttempts} · Created {new Date(job.createdAt).toLocaleString()}</p>
                {job.lastError && <p className="muted">{job.lastError}</p>}
                {job.status === "DEAD_LETTER" && role === "ADMIN" && <button disabled={busy} onClick={() => runTask(async () => { await request(`/jobs/${job.id}/replay`, { method: "POST" }); await loadJobs(); }, "Job replay queued.")}>Replay</button>}
              </article>)}
            </section>
          )}

          {tab === "Notifications" && (
            <section className="panel fg-panel">
              <div className="fg-row"><div><h2>Notifications</h2><p className="muted">In-app event messages for your account.</p></div><button className="secondary" onClick={() => runTask(loadNotifications, "Notifications refreshed.")}>Refresh</button></div>
              {!notifications.length ? <p className="fg-empty">No notifications yet.</p> : notifications.map(item => <article className="fg-deficiency" key={item.id}>
                <div className="fg-row"><strong>{item.title}</strong><span className="fg-status">{item.readAt ? "Read" : "Unread"}</span></div>
                <p>{item.message}</p><small className="muted">{pretty(item.type)} · {new Date(item.createdAt).toLocaleString()}</small>
                {!item.readAt && <div className="fg-actions"><button className="secondary" onClick={() => markNotificationRead(item.id)}>Mark read</button></div>}
              </article>)}
            </section>
          )}

          {tab === "Application detail" && detail && (
            <section className="panel fg-panel fg-detail">
              <div className="fg-detail-head">
                <div>
                  <p className="eyebrow">APPLICATION RECORD</p>
                  <h2>{detail.applicationNumber || detail.id}</h2>
                  <p className="muted">{detail.institution?.name} Ãƒâ€šÃ‚Â· {detail.academicYear}</p>
                </div>
                <span className="fg-status">{pretty(detail.status)}</span>
              </div>

              <div className="fg-facts">
                <div><span>Workflow</span><strong>{detail.workflow ? `${pretty(detail.workflow.category)} Ãƒâ€šÃ‚Â· v${detail.workflow.version}` : "Not assigned"}</strong></div>
                <div><span>Campus</span><strong>{detail.campus?.name || "Not specified"}</strong></div>
                <div><span>Programme</span><strong>{detail.programme?.name || "Not specified"}</strong></div>
                <div><span>Created</span><strong>{detail.createdAt ? new Date(detail.createdAt).toLocaleDateString() : "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â"}</strong></div>
              </div>

              <div className="fg-actions">
                <button className="secondary" disabled={busy} onClick={refreshCurrentApplication}>Refresh application status</button>
                {detail.status === "DRAFT" && ["ADMIN", "INSTITUTION_USER"].includes(role) && <button disabled={busy} onClick={() => submitApplication(detail.id)}>Submit application</button>}
                {["SUBMITTED", "RESUBMITTED"].includes(detail.status) && ["ADMIN", "REVIEWER"].includes(role) && <button disabled={busy} onClick={() => startReview(detail.id)}>Start review</button>}
              </div>

              <div className="fg-section">
                <div className="fg-section">
                          <section className="panel" style={{ marginBottom: 20, padding: 18, border: "1px solid #d7dce5", borderRadius: 12 }}>
          <div className="fg-row"><div><h3>Compliance Evidence</h3><p className="muted">A readiness estimate is not an official AICTE score, approval prediction, or certification.</p></div>{["ADMIN", "REVIEWER", "INSTITUTION_USER"].includes(role) && <button className="secondary" disabled={busy} onClick={refreshComplianceAnalysis}>Refresh analysis</button>}</div>
          {compliance?.readinessEstimate && <article className="fg-deficiency"><strong>Readiness estimate: {compliance.readinessEstimate.value}%</strong><p className="muted">Rule set {compliance.readinessEstimate.ruleVersion} · updated {new Date(compliance.readinessEstimate.computedAt).toLocaleString()}</p><p className="muted">{compliance.readinessEstimate.meaning}</p></article>}
          {!!compliance?.findings?.length && <div className="fg-section"><h4>Persisted findings</h4>{compliance.findings.map((finding: any) => <article className="fg-deficiency" key={finding.id}>
            <div className="fg-row"><strong>{finding.title}</strong><span className="fg-status">{pretty(finding.severity)} · {pretty(finding.status)}</span></div>
            <p>{finding.explanation}</p><small className="muted">{finding.code} · Rule {finding.ruleVersion} · refreshed {new Date(finding.lastRefreshedAt).toLocaleString()}</small>
            {finding.resolutionNotes && <p className="muted">Reviewer note: {finding.resolutionNotes} · actor {finding.resolvedByUserId || "not recorded"}</p>}
            {(Array.isArray(finding.evidenceReferences) ? finding.evidenceReferences : []).map((reference: any, index: number) => <div className="fg-requirement" key={`${finding.id}-${index}`}>
              <strong>{reference.documentId ? `Document ${reference.documentId} · version ${reference.version ?? "?"}` : reference.requirementCode || "Related record"}</strong>
              {reference.fieldName && <p className="muted">{pretty(reference.fieldName)}{reference.pageNumber ? ` · page ${reference.pageNumber}` : ""}{reference.value ? ` · ${String(reference.value)}` : ""}</p>}
              {reference.sourceText && <p className="muted">Source: {reference.sourceText}</p>}
            </div>)}
            {finding.status !== "RESOLVED" && finding.status !== "DISMISSED" && ["ADMIN", "REVIEWER"].includes(role) && <div className="fg-section"><label>Review or resolution note</label><textarea rows={2} maxLength={2000} value={findingNotes[finding.id] || ""} onChange={event => setFindingNotes(previous => ({ ...previous, [finding.id]: event.target.value }))} /><div className="fg-actions"><button className="secondary" onClick={() => reviewFinding(finding.id, "ACKNOWLEDGED")}>Acknowledge</button><button className="secondary" onClick={() => reviewFinding(finding.id, "RESOLVED")}>Resolve</button><button className="secondary" onClick={() => reviewFinding(finding.id, "DISMISSED")}>Dismiss</button></div></div>}
          </article>)}</div>}
          <p style={{ color: "#64748b", marginTop: 4 }}>
            Link uploaded documents to this application's workflow requirements. A linked file or verified extracted field does not automatically mean a requirement is compliant.
          </p>

          {!compliance && (
            <p style={{ color: "#64748b" }}>Compliance evidence has not loaded yet. Close and reopen this application to refresh it.</p>
          )}

          {compliance?.message && <p>{compliance.message}</p>}

          {compliance?.items?.length > 0 && (
            <div style={{ display: "grid", gap: 12 }}>
              {compliance.items.map((req: any) => {
                const statusLabels: Record<string, string> = {
                  MISSING_EVIDENCE: "Missing evidence",
                  EVIDENCE_LINKED: "Evidence linked Ãƒâ€šÃ‚Â· no extracted fields yet",
                  EXTRACTION_REVIEW_PENDING: "Extraction review pending",
                  FIELD_REVIEWED: "At least one extracted field verified"
                };
                const statusColors: Record<string, string> = {
                  MISSING_EVIDENCE: "#b91c1c",
                  EVIDENCE_LINKED: "#475569",
                  EXTRACTION_REVIEW_PENDING: "#a16207",
                  FIELD_REVIEWED: "#166534"
                };
                return (
                  <article key={req.id} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 14 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
                      <strong>{req.code} Ãƒâ€šÃ‚Â· {req.description}</strong>
                      <span style={{ color: statusColors[req.evidenceStatus] || "#475569", fontWeight: 600 }}>
                        {statusLabels[req.evidenceStatus] || req.evidenceStatus}
                      </span>
                    </div>
                    <small style={{ color: "#64748b" }}>
                      {req.mandatory ? "Mandatory requirement" : "Optional requirement"} Ãƒâ€šÃ‚Â· {req.linkedDocuments?.length || 0} linked document(s) Ãƒâ€šÃ‚Â· {req.verifiedFieldCount || 0} verified field(s)
                    </small>

                    {req.linkedDocuments?.length > 0 && (
                      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                        {req.linkedDocuments.map((doc: any) => (
                          <div key={doc.id} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, padding: 8, background: "#f8fafc", borderRadius: 8 }}>
                            <div>
                              <div>{doc.originalName}</div>
                              <small style={{ color: "#64748b" }}>
                                Version {doc.version} Ãƒâ€šÃ‚Â· {doc.status} Ãƒâ€šÃ‚Â· {doc.extractions?.filter((x: any) => x.humanVerified).length || 0}/{doc.extractions?.length || 0} fields verified
                              </small>
                            </div>
                            <button type="button" disabled={busy} onClick={() => unlinkRequirementEvidence(req.id, doc.id)}>
                              Unlink
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                      <select
                        aria-label={`Select evidence for ${req.code}`}
                        value={evidenceSelection[req.id] || ""}
                        onChange={(e) => setEvidenceSelection((prev) => ({ ...prev, [req.id]: e.target.value }))}
                        style={{ flex: "1 1 220px", minWidth: 0, padding: 8 }}
                      >
                        <option value="">Select an uploaded documentÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦</option>
                        {documents.filter((doc) => doc.status !== "REJECTED").map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.originalName} Ãƒâ€šÃ‚Â· v{doc.version}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy || !evidenceSelection[req.id]}
                        onClick={() => linkRequirementEvidence(req.id)}
                      >
                        Link evidence
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {compliance && !compliance.message && compliance.items?.length === 0 && (
            <p style={{ color: "#64748b" }}>This workflow has no requirements configured yet.</p>
          )}

          {compliance?.items?.length > 0 && (
            <p style={{ fontSize: 12, color: "#64748b", marginBottom: 0 }}>
              These are evidence-tracking states, not a formal compliance decision. A reviewer must assess evidence against the requirement.
            </p>
          )}
        </section>
<h3>Document intelligence</h3>
                  <p className="muted">Upload PDF or image evidence, extract searchable text, and review machine-generated field suggestions. Extracted values are not verified until a reviewer checks the source.</p>
                  <form className="fg-form" onSubmit={uploadDocument}>
                    <label>Choose document (PDF, JPG or PNG)</label>
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                      onChange={e => setSelectedFile(e.target.files?.[0] || null)}
                      required
                    />
                    {selectedFile && <p className="muted">Selected: {selectedFile.name} Ãƒâ€šÃ‚Â· {(selectedFile.size / 1024).toFixed(1)} KB</p>}
                    <button disabled={busy || !selectedFile}>Upload document</button>
                  </form>
                  <h3>Uploaded documents ({documents.length})</h3>
                  {documents.length === 0 ? (
                    <p className="fg-empty">No documents uploaded for this application yet.</p>
                  ) : documents.map(doc => (
                    <article className="fg-deficiency" key={doc.id}>
                      <div className="fg-row">
                        <strong>{doc.originalName}</strong>
                        <span className="fg-status">{pretty(doc.status)}</span>
                      </div>
                      <p className="muted">Version {doc.version} Ãƒâ€šÃ‚Â· {doc.mimeType}</p>
                      <p className="muted">Uploaded {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleString() : "Date unavailable"}</p>
                      <p className="muted">Processing: {pretty(doc.processingState || "UNKNOWN")} · malware scan: {pretty(doc.scanResult || "UNKNOWN")}</p>
                      {doc.processingError && <p role="alert" className="muted">{doc.processingError}</p>}
                      {!!doc.processingWarnings?.length && <ul>{doc.processingWarnings.map((warning, index) => <li className="muted" key={index}>{warning}</li>)}</ul>}
                      <p className="muted">Extracted fields: {doc.extractions?.length ?? 0}</p>
                      <div className="fg-actions">
                        <button type="button" className="secondary" disabled={busy || doc.status !== "AVAILABLE"} onClick={() => downloadDocument(doc.id, doc.originalName)}>{doc.status === "AVAILABLE" ? "Download original" : "Unavailable while quarantined"}</button>
                        <button
                          type="button"
                          disabled={busy || doc.processingState === "RUNNING" || doc.processingState === "QUEUED"}
                          onClick={() => processDocument(doc.id)}
                        >
                          {doc.processingState === "FAILED" ? "Retry processing" : "Queue reprocessing"}
                        </button>
                      </div>

                      {!!doc.extractions?.length && (
                        <div className="fg-section">
                          <h4>Extracted field suggestions</h4>
                          {doc.extractions.map((field: any) => (
                            <div className="fg-requirement" key={field.id}>
                              <strong>{pretty(field.fieldName)}</strong>
                              <p>{String(field.verifiedValue ?? field.extractedValue ?? "No value extracted")}</p>
                              <p className="muted">
                                {pretty(field.confidenceBasis || "HEURISTIC_UNCALIBRATED")} · stored signal is not a calibrated probability
                              </p>
                              {field.sourceText && (
                                <p className="muted">
                                  {field.pageNumber ? `Source page ${field.pageNumber}: ` : "Source text: "}{field.sourceText}
                                </p>
                              )}
                              {!!field.reviewEvents?.length && <details><summary>Review history ({field.reviewEvents.length})</summary>{field.reviewEvents.map((event: any) => <p className="muted" key={event.id}>{pretty(event.action)} · {new Date(event.createdAt).toLocaleString()} · {String(event.reviewedValue)}{event.notes ? ` · ${event.notes}` : ""}</p>)}</details>}
                              <span className="fg-status">
                                {field.humanVerified
                                  ? "Human verified"
                                  : "Awaiting human verification"}
                              </span>
                              {!field.humanVerified && ["ADMIN", "REVIEWER"].includes(role) && (
                                <div className="fg-actions">
                                  <input aria-label={`Review value for ${field.fieldName}`} value={fieldCorrections[field.id] ?? String(field.extractedValue ?? "")} onChange={event => setFieldCorrections(previous => ({ ...previous, [field.id]: event.target.value }))} />
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => verifyExtraction(doc.id, field.id, fieldCorrections[field.id] ?? String(field.extractedValue ?? ""))}
                                  >
                                    Verify or correct
                                  </button>
                                </div>
                              )}
                              {field.humanVerified && field.verifiedAt && (
                                <p className="muted">
                                  Verified on {new Date(field.verifiedAt).toLocaleString()}
                                  {field.verifiedByUserId
                                    ? ` Ãƒâ€šÃ‚Â· Reviewer: ${field.verifiedByUserId}`
                                    : ""}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <h3>Requirements checklist</h3>
                {!detail.workflow?.requirements?.length ? <p className="fg-empty">No workflow requirements are linked. This is not a compliance clearance.</p> : detail.workflow.requirements.map((r: Requirement) => (
                  <div className="fg-requirement" key={r.id}>
                    <strong>{r.code}</strong><p>{r.description}</p>
                    <span className={r.mandatory ? "fg-required" : "muted"}>{r.mandatory ? "Mandatory" : "Optional"}</span>
                    
                  </div>
                ))}
              </div>

              <div className="fg-section">
                <div className="fg-row"><div><h3>Potential record matches</h3><p className="muted">Explainable candidates for human review. Similar names do not establish identity and no records are merged.</p></div>{["ADMIN", "REVIEWER"].includes(role) && <button className="secondary" disabled={busy} onClick={refreshApplicationMatches}>Refresh matches</button>}</div>
                {!matches.length ? <p className="fg-empty">No potential matches recorded for this application.</p> : matches.map(match => {
                  const other = match.leftApplicationId === detail.id ? match.rightApplication : match.leftApplication;
                  return <article className="fg-deficiency" key={match.id}>
                    <div className="fg-row"><strong>{other?.institution?.name || "Candidate application"} · {other?.applicationNumber || other?.id}</strong><span className="fg-status">{pretty(match.reviewStatus)}</span></div>
                    <p className="muted">Rule signal: {Math.round(match.score * 100)}% similarity indicator. It is not a probability of identity.</p>
                    {(Array.isArray(match.reasons) ? match.reasons : []).map((reason: any, index: number) => <p className="muted" key={index}>{pretty(reason.field || reason.signal)} · {reason.interpretation || reason.signal}</p>)}
                    {match.reviewStatus === "SUGGESTED" && ["ADMIN", "REVIEWER"].includes(role) && <div className="fg-actions"><button className="secondary" onClick={() => reviewMatch(match.id, "CONFIRMED_POTENTIAL")}>Keep for review</button><button className="secondary" onClick={() => reviewMatch(match.id, "DEFERRED")}>Defer</button><button className="secondary" onClick={() => reviewMatch(match.id, "DISMISSED")}>Dismiss</button></div>}
                  </article>;
                })}
              </div>

              {detail.status === "UNDER_REVIEW" && ["ADMIN", "REVIEWER"].includes(role) && (
                <div className="fg-section">
                  <h3>Raise deficiency</h3>
                  <form className="fg-form fg-inline-form" onSubmit={raiseDeficiency}>
                    <label>Code</label>
                    <input value={deficiencyCode} onChange={e => setDeficiencyCode(e.target.value)} required />
                    <label>Description</label>
                    <textarea rows={3} value={deficiencyDescription} onChange={e => setDeficiencyDescription(e.target.value)} minLength={3} required />
                    <button disabled={busy}>Raise deficiency</button>
                  </form>
                </div>
              )}

              <div className="fg-section">
                <h3>Deficiencies</h3>
                {!detail.deficiencies?.length ? <p className="fg-empty">No deficiencies recorded.</p> : detail.deficiencies.map((d: any) => (
                  <article className="fg-deficiency" key={d.id}>
                    <div className="fg-row">
                      <strong>{d.code}</strong>
                      <span className="fg-status">{pretty(d.status)}</span>
                    </div>
                    <p>{d.description}</p>
                    {d.responseText && <div className="fg-requirement"><strong>Submitted response</strong><p>{d.responseText}</p><small className="muted">{d.responseSubmittedAt ? new Date(d.responseSubmittedAt).toLocaleString() : "Submission time not recorded"}</small></div>}
                    <div className="fg-actions">
                      {d.status === "OPEN" && ["ADMIN", "INSTITUTION_USER"].includes(role) && <div className="fg-form"><label htmlFor={`def-response-${d.id}`}>Response</label><textarea id={`def-response-${d.id}`} rows={3} minLength={3} maxLength={4000} value={deficiencyResponses[d.id] || ""} onChange={e => setDeficiencyResponses(previous => ({ ...previous, [d.id]: e.target.value }))} /><button disabled={busy || (deficiencyResponses[d.id] || "").trim().length < 3} onClick={() => respondToDeficiency(d.id, deficiencyResponses[d.id])}>Submit response</button></div>}
                      {d.status === "RESPONSE_SUBMITTED" && ["ADMIN", "REVIEWER"].includes(role) && <button disabled={busy} onClick={() => closeDeficiency(d.id)}>Close after review</button>}
                    </div>
                  </article>
                ))}
              </div>

              {["UNDER_REVIEW", "RESUBMITTED"].includes(detail.status) && role === "ADMIN" && (
                <div className="fg-section">
                  <h3>Record formal decision</h3>
                  <p className="muted">The API will reject this action if unresolved deficiencies remain. A decision is not itself proof that an approval letter is available.</p>
                  <form className="fg-form fg-inline-form" onSubmit={issueDecision}>
                    <label>Outcome</label>
                    <select value={decisionOutcome} onChange={e => setDecisionOutcome(e.target.value)}>
                      <option value="APPROVED">Approved</option>
                      <option value="REJECTED">Rejected</option>
                      <option value="WITHDRAWN">Withdrawn</option>
                    </select>
                    <label>Authority</label>
                    <input value={decisionAuthority} onChange={e => setDecisionAuthority(e.target.value)} minLength={2} required />
                    <label>Reference (optional)</label>
                    <input value={decisionReference} onChange={e => setDecisionReference(e.target.value)} maxLength={200} />
                    <button disabled={busy}>Record decision</button>
                  </form>
                </div>
              )}

              <div className="fg-section">
                <h3>Formal decisions</h3>
                {!detail.decisions?.length ? <p className="fg-empty">No formal decision recorded.</p> : detail.decisions.map((d: any) => (
                  <article className="fg-deficiency" key={d.id}>
                    <strong>{pretty(d.outcome)}</strong>
                    <p>{d.authority} Ãƒâ€šÃ‚Â· {new Date(d.issuedAt).toLocaleString()}</p>
                    {d.reference && <p className="muted">Reference: {d.reference}</p>}
                    <p className="muted">Approval letter: {d.letterStorageKey ? "Storage reference exists" : "Not recorded"}</p>
                  </article>
                ))}
              </div>

              <div className="fg-section">
                <h3>Review history</h3>
                {!detail.reviews?.length ? <p className="fg-empty">No review records.</p> : detail.reviews.map((r: any) => (
                  <div className="fg-row" key={r.id}>
                    <div><strong>{pretty(r.status)}</strong><p className="muted">Started {r.startedAt ? new Date(r.startedAt).toLocaleString() : "ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â"}</p></div>
                  </div>
                ))}
              </div>
              <button className="secondary" onClick={() => setTab("Applications")}>Back to applications</button>
            </section>
          )}

          {tab === "Application detail" && !detail && (
            <section className="panel fg-panel"><p className="fg-empty">Choose an application from the register to see its details.</p><button onClick={() => setTab("Applications")}>Open register</button></section>
          )}
        </section>
      )}

      <footer>FLOWGUARD Ãƒâ€šÃ‚Â· TRACEABLE BY DESIGN Ãƒâ€šÃ‚Â· DEVELOPMENT BUILD</footer>
    </main>
  );
}

function ApplicationList({ applications, onOpen }: {
  applications: Application[];
  onOpen: (id: string) => void;
}) {
  if (!applications.length) return <p className="fg-empty">No applications found.</p>;

  return (
    <div className="fg-list">
      {applications.map(app => (
        <article className="fg-app-row" key={app.id}>
          <div className="fg-app-main">
            <strong>{app.applicationNumber || app.id}</strong>
            <p>{app.institution?.name || "Institution"} Ãƒâ€šÃ‚Â· {app.academicYear}</p>
            <span className="fg-status">{pretty(app.status)}</span>
          </div>
          <button className="secondary" onClick={() => onOpen(app.id)}>Open</button>
        </article>
      ))}
    </div>
  );
}







