import { useEffect, useMemo, useState } from "react";
import type { PointerEvent, WheelEvent } from "react";

type GraphNode = {
  id: string;
  type: string;
  label: string;
  status?: string;
  details: Record<string, string | number | boolean | null>;
  provenance: { sourceTable: string; sourceId: string; projectionVersion: number };
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: string;
  provenance: { sourceTable: string; sourceField: string; confidence: number; verificationState: string };
};

type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] };
type Request = (path: string, init?: RequestInit, authToken?: string) => Promise<any>;

const nodeTypes = ["PROMOTER", "INSTITUTION", "CAMPUS", "PROGRAMME", "COURSE_OFFERING", "APPLICATION", "WORKFLOW", "REQUIREMENT", "DOCUMENT", "EVIDENCE_EXTRACTION", "DEFICIENCY", "REVIEW", "INSPECTION", "EVC_ASSESSMENT", "FORMAL_DECISION", "APPROVAL", "OBLIGATION", "EXTERNAL_IDENTIFIER"];

function humanize(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
}

function mergeGraph(current: GraphData, added: GraphData): GraphData {
  return {
    nodes: [...new Map([...current.nodes, ...added.nodes].map(node => [node.id, node])).values()],
    edges: [...new Map([...current.edges, ...added.edges].map(edge => [edge.id, edge])).values()]
  };
}

export function GraphExplorer({ token, request }: { token: string; request: Request }) {
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [relationshipFilter, setRelationshipFilter] = useState("");
  const [focusId, setFocusId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragOrigin, setDragOrigin] = useState<{ pointerId: number; x: number; y: number; initialX: number; initialY: number } | null>(null);
  const [syncStatus, setSyncStatus] = useState<any>(null);
  const [authoritativeRecord, setAuthoritativeRecord] = useState<Record<string, unknown> | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");

  useEffect(() => {
    let active = true;
    void request("/graph/status", {}, token).then(value => { if (active) setSyncStatus(value); }).catch(caught => {
      if (active) setSyncStatus({ statusError: caught instanceof Error ? caught.message : "Graph status unavailable" });
    });
    return () => { active = false; };
  }, [request, token]);

  const positions = useMemo(() => {
    const center = { x: 450, y: 280 };
    const root = graph.nodes.find(node => node.id === focusId) || graph.nodes[0];
    const others = graph.nodes.filter(node => node.id !== root?.id);
    const coordinates = new Map<string, { x: number; y: number }>();
    if (root) coordinates.set(root.id, center);
    others.forEach((node, index) => {
      const ring = Math.floor(index / 9);
      const withinRing = index % 9;
      const ringCount = Math.min(9, others.length - ring * 9);
      const angle = (2 * Math.PI * withinRing) / ringCount - Math.PI / 2;
      const radius = Math.min(135 + ring * 110, 240);
      coordinates.set(node.id, { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
    });
    return coordinates;
  }, [focusId, graph.nodes]);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    setSelectedEdgeId("");
    try {
      const params = new URLSearchParams({ q: query.trim(), limit: "20" });
      if (type) params.set("type", type);
      const result: GraphData = await request(`/graph/search?${params.toString()}`, {}, token);
      setGraph(result);
      const root = result.nodes[0]?.id || "";
      setFocusId(root);
      setSelectedId(root);
      setAuthoritativeRecord(null);
      if (result.nodes[0]) void loadAuthoritativeRecord(result.nodes[0]);
      setNotice(result.nodes.length ? `${result.nodes.length} records shown. Select a node to expand its relationships.` : "No matching records found.");
    } catch (caught) {
      setGraph({ nodes: [], edges: [] });
      setError(caught instanceof Error ? caught.message : "Graph search failed.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAuthoritativeRecord(node: GraphNode) {
    setSourceLoading(true);
    setSourceError("");
    setAuthoritativeRecord(null);
    try {
      const source = await request(`/graph/records/${encodeURIComponent(node.provenance.sourceTable)}/${encodeURIComponent(node.provenance.sourceId)}`, {}, token);
      setAuthoritativeRecord(source.record);
    } catch (caught) {
      setSourceError(caught instanceof Error ? caught.message : "The PostgreSQL source record could not be verified.");
    } finally {
      setSourceLoading(false);
    }
  }

  async function expand(node: GraphNode) {
    setSelectedId(node.id);
    setSelectedEdgeId("");
    void loadAuthoritativeRecord(node);
    setLoading(true);
    setError("");
    try {
      const result: GraphData = await request(`/graph/nodes/${encodeURIComponent(node.id)}?limit=60`, {}, token);
      setGraph(current => mergeGraph(current, result));
      setFocusId(node.id);
      setNotice(`Expanded ${node.label}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Relationships could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  function startPan(event: PointerEvent<SVGSVGElement>) {
    if ((event.target as Element).closest("[data-graph-item]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragOrigin({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, initialX: pan.x, initialY: pan.y });
  }

  function movePan(event: PointerEvent<SVGSVGElement>) {
    if (!dragOrigin || event.pointerId !== dragOrigin.pointerId) return;
    setPan({ x: dragOrigin.initialX + event.clientX - dragOrigin.x, y: dragOrigin.initialY + event.clientY - dragOrigin.y });
  }

  function zoomCanvas(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    setZoom(current => Math.max(0.55, Math.min(1.8, current + (event.deltaY < 0 ? 0.08 : -0.08))));
  }

  const selectedNode = graph.nodes.find(node => node.id === selectedId);
  const selectedEdge = graph.edges.find(edge => edge.id === selectedEdgeId);
  const visibleNodes = graph.nodes.filter(node => !statusFilter || node.status === statusFilter);
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id));
  const visibleEdges = graph.edges.filter(edge => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target) && (!relationshipFilter || edge.type === relationshipFilter));
  const transform = `translate(${450 + pan.x} ${280 + pan.y}) scale(${zoom}) translate(-450 -280)`;

  return <section className="panel fg-panel fg-graph-panel">
    <div className="fg-row"><div><h2>Relationship graph</h2><p className="muted">Search a promoter, institution, application, or related record. Select nodes to follow verified links.</p></div><span className="fg-pill">Graph projection</span></div>
    {syncStatus && <p className={syncStatus.statusError || (syncStatus.configured && !syncStatus.available) ? "fg-error" : "fg-message"} role={syncStatus.statusError || (syncStatus.configured && !syncStatus.available) ? "alert" : "status"}>{syncStatus.statusError || (!syncStatus.configured ? "Graph is not configured; application records remain available in PostgreSQL." : !syncStatus.available ? "Graph database is unavailable; application records remain available in PostgreSQL." : `${syncStatus.pendingEvents ? "Graph projection is syncing and may be stale" : "Graph projection available"} · v${syncStatus.projection?.version ?? 0} · ${syncStatus.pendingEvents} refresh${syncStatus.pendingEvents === 1 ? "" : "es"} queued${syncStatus.projection?.lastError ? ` · ${syncStatus.projection.lastError}` : ""}`)}</p>}
    <form className="fg-graph-search" onSubmit={event => void search(event)}>
      <label htmlFor="graph-query">Search records</label>
      <input id="graph-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="Promoter, institution, application number…" minLength={2} maxLength={120} />
      <label htmlFor="graph-type">Record type</label>
      <select id="graph-type" value={type} onChange={event => setType(event.target.value)}><option value="">All types</option>{nodeTypes.map(value => <option key={value} value={value}>{humanize(value)}</option>)}</select>
      <button disabled={loading || query.trim().length < 2}>{loading ? "Loading…" : "Search graph"}</button>
    </form>
    {error && <p className="fg-error" role="alert">{error}</p>}
    {notice && <p className="fg-message" role="status">{notice}</p>}
    {!graph.nodes.length && !loading && !error && <p className="fg-empty">Search for a record to explore its relationships. Search results include directly connected records.</p>}
    {graph.nodes.length > 0 && <>
      <div className="fg-graph-toolbar" aria-label="Graph controls">
        <button className="secondary" type="button" onClick={() => setZoom(value => Math.min(1.8, value + 0.12))} aria-label="Zoom in">+</button>
        <button className="secondary" type="button" onClick={() => setZoom(value => Math.max(0.55, value - 0.12))} aria-label="Zoom out">−</button>
        <button className="secondary" type="button" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} aria-label="Reset graph view">Reset view</button>
        <label className="fg-graph-filter">Status <select aria-label="Filter graph by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="">All statuses</option>{[...new Set(graph.nodes.map(node => node.status).filter((value): value is string => Boolean(value)))].sort().map(value => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
        <label className="fg-graph-filter">Relationship <select aria-label="Filter graph by relationship" value={relationshipFilter} onChange={event => setRelationshipFilter(event.target.value)}><option value="">All relationships</option>{[...new Set(graph.edges.map(edge => edge.type))].sort().map(value => <option key={value} value={value}>{humanize(value)}</option>)}</select></label>
        <span className="muted">Drag the background to pan · Scroll to zoom · Click a record to expand</span>
      </div>
      <div className="fg-graph-canvas">
        <svg viewBox="0 0 900 560" role="group" aria-label="Interactive graph of tenant institutions and their linked workflow records" onPointerDown={startPan} onPointerMove={movePan} onPointerUp={() => setDragOrigin(null)} onPointerCancel={() => setDragOrigin(null)} onWheel={zoomCanvas}>
          <g transform={transform}>
            {visibleEdges.map(edge => {
              const from = positions.get(edge.source);
              const to = positions.get(edge.target);
              if (!from || !to) return null;
              const middleX = (from.x + to.x) / 2;
              const middleY = (from.y + to.y) / 2;
              return <g key={edge.id} data-graph-item="true" className={`fg-graph-edge ${selectedEdgeId === edge.id ? "fg-graph-edge-selected" : ""}`} role="button" tabIndex={0} aria-label={`${humanize(edge.type)} relationship. View provenance`} onClick={() => { setSelectedEdgeId(edge.id); setSelectedId(""); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedEdgeId(edge.id); setSelectedId(""); } }}>
                <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                <text x={middleX} y={middleY - 5}>{humanize(edge.type)}</text>
              </g>;
            })}
            {visibleNodes.map(node => {
              const point = positions.get(node.id);
              if (!point) return null;
              return <g key={node.id} data-graph-item="true" className={`fg-graph-node ${selectedId === node.id ? "fg-graph-node-selected" : ""}`} role="button" tabIndex={0} aria-label={`${humanize(node.type)}: ${node.label}${node.status ? `, ${humanize(node.status)}` : ""}. Activate to expand relationships`} transform={`translate(${point.x} ${point.y})`} onClick={() => void expand(node)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void expand(node); } }}>
                <circle r={node.id === focusId ? 34 : 29} />
                <text className="fg-graph-type" y="-3">{humanize(node.type).slice(0, 18)}</text>
                <text className="fg-graph-label" y="12">{node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}</text>
                <title>{`${humanize(node.type)} · ${node.label}${node.status ? ` · ${humanize(node.status)}` : ""}`}</title>
              </g>;
            })}
          </g>
        </svg>
      </div>
      <div className="fg-graph-columns">
        <section className="fg-graph-records" aria-labelledby="graph-record-list-title">
          <h3 id="graph-record-list-title">Records ({graph.nodes.length})</h3>
          <ul>{visibleNodes.map(node => <li key={node.id}><button type="button" className="fg-graph-record-button" onClick={() => void expand(node)}><strong>{node.label}</strong><span>{humanize(node.type)}{node.status ? ` · ${humanize(node.status)}` : ""}</span></button></li>)}</ul>
          {!visibleNodes.length && <p className="fg-empty">No records match the current status filter.</p>}
        </section>
        <section className="fg-graph-details" aria-live="polite">
          <h3>{selectedEdge ? "Relationship provenance" : "Record details"}</h3>
          {selectedEdge ? <><p><strong>{humanize(selectedEdge.type)}</strong></p><dl><dt>Source</dt><dd>{selectedEdge.provenance.sourceTable}.{selectedEdge.provenance.sourceField}</dd><dt>Link state</dt><dd>{humanize(selectedEdge.provenance.verificationState)}</dd><dt>Confidence</dt><dd>{Math.round(selectedEdge.provenance.confidence * 100)}%</dd><dt>From</dt><dd>{graph.nodes.find(node => node.id === selectedEdge.source)?.label || selectedEdge.source}</dd><dt>To</dt><dd>{graph.nodes.find(node => node.id === selectedEdge.target)?.label || selectedEdge.target}</dd></dl></> : selectedNode ? <><p><strong>{selectedNode.label}</strong><span className="fg-status">{humanize(selectedNode.type)} · graph projection v{selectedNode.provenance.projectionVersion}</span></p>{sourceLoading ? <p className="muted">Verifying source record in PostgreSQL…</p> : sourceError ? <p className="fg-error" role="alert">{sourceError}. This graph entry may be stale; refresh the projection.</p> : authoritativeRecord ? <><p className="fg-message">Current values verified from PostgreSQL.</p><dl>{Object.entries(authoritativeRecord).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{value === null ? "—" : value instanceof Object ? JSON.stringify(value) : String(value)}</dd></div>)}</dl></> : <p className="fg-empty">Select a record to verify its current details in PostgreSQL.</p>}</> : <p className="fg-empty">Select a record or relationship to see its details and source.</p>}
        </section>
      </div>
    </>}
    <p className="muted fg-graph-footnote">Relationships are projected from recorded foreign keys. External identifiers retain their issuer and namespace; an application number is not labeled as an AICTE PID.</p>
  </section>;
}
