import neo4j, { type Driver } from "neo4j-driver";
import { randomUUID } from "node:crypto";
import { env } from "./env";
import { prisma } from "./db";

export type GraphNodeType = "PROMOTER" | "INSTITUTION" | "CAMPUS" | "PROGRAMME" | "COURSE_OFFERING" | "APPLICATION" | "WORKFLOW" | "REQUIREMENT" | "DOCUMENT" | "EVIDENCE_EXTRACTION" | "DEFICIENCY" | "REVIEW" | "INSPECTION" | "EVC_ASSESSMENT" | "FORMAL_DECISION" | "APPROVAL" | "OBLIGATION" | "EXTERNAL_IDENTIFIER";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  status?: string;
  details: Record<string, string | number | boolean | null>;
  provenance: { sourceTable: string; sourceId: string; projectionVersion: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  provenance: { sourceTable: string; sourceField: string; confidence: number; verificationState: "VERIFIED_FOREIGN_KEY" | "EXACT_KEY_MATCH" };
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphStore {
  isConfigured(): boolean;
  checkAvailability(): Promise<boolean>;
  search(input: { tenantId: string; query: string; type?: GraphNodeType; limit: number }): Promise<GraphResult>;
  expand(input: { tenantId: string; nodeId: string; limit: number }): Promise<GraphResult>;
  rebuildTenant(tenantId: string): Promise<{ version: number; nodeCount: number; edgeCount: number }>;
  close(): Promise<void>;
}

export class GraphProjectionBusyError extends Error {}

type NodeInput = Omit<GraphNode, "provenance"> & { sourceTable: string; sourceId: string; tenantId: string };
type EdgeInput = Omit<GraphEdge, "provenance"> & { sourceTable: string; sourceField: string; confidence: number; verificationState: "VERIFIED_FOREIGN_KEY" | "EXACT_KEY_MATCH" };

function nodeId(type: GraphNodeType, sourceId: string) {
  return `${type}:${sourceId}`;
}

function mapResult(rows: Array<{ root: any; neighbor: any; relationship: any }>): GraphResult {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const row of rows) {
    for (const value of [row.root, row.neighbor]) {
      if (!value) continue;
      const props = value.properties as Record<string, any>;
      const id = String(props.nodeId);
      nodes.set(id, {
        id,
        type: props.type as GraphNodeType,
        label: String(props.label),
        ...(props.status ? { status: String(props.status) } : {}),
        details: JSON.parse(String(props.detailsJson || "{}")),
        provenance: { sourceTable: String(props.sourceTable), sourceId: String(props.sourceId), projectionVersion: Number(props.projectionVersion) }
      });
    }
    if (row.relationship) {
      const props = row.relationship.properties as Record<string, any>;
      const id = String(props.edgeId);
      edges.set(id, {
        id,
        source: String(props.sourceNodeId),
        target: String(props.targetNodeId),
        type: String(props.type),
        provenance: { sourceTable: String(props.sourceTable), sourceField: String(props.sourceField), confidence: Number(props.confidence), verificationState: String(props.verificationState) as "VERIFIED_FOREIGN_KEY" | "EXACT_KEY_MATCH" }
      });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

class Neo4jGraphStore implements GraphStore {
  private driver: Driver | null = null;

  isConfigured() {
    return Boolean(env.NEO4J_URI && env.NEO4J_USER && env.NEO4J_PASSWORD);
  }

  private getDriver() {
    if (!this.isConfigured()) throw new Error("Graph database is not configured");
    if (!this.driver) this.driver = neo4j.driver(env.NEO4J_URI!, neo4j.auth.basic(env.NEO4J_USER!, env.NEO4J_PASSWORD!));
    return this.driver;
  }

  async checkAvailability() {
    if (!this.isConfigured()) return false;
    const session = this.getDriver().session({ database: env.NEO4J_DATABASE });
    try {
      await session.run("RETURN 1");
      return true;
    } catch {
      return false;
    } finally {
      await session.close();
    }
  }

  async search(input: { tenantId: string; query: string; type?: GraphNodeType; limit: number }) {
    const session = this.getDriver().session({ database: env.NEO4J_DATABASE });
    try {
      const result = await session.executeRead(tx => tx.run(
        "MATCH (root:FlowGuardNode {tenantId: $tenantId}) WHERE toLower(root.label) CONTAINS toLower($query) AND ($type IS NULL OR root.type = $type) OPTIONAL MATCH (root)-[relationship:RELATED_TO]-(neighbor:FlowGuardNode {tenantId: $tenantId}) RETURN root, neighbor, relationship LIMIT $limit",
        { tenantId: input.tenantId, query: input.query, type: input.type ?? null, limit: neo4j.int(input.limit) }
      ));
      return mapResult(result.records.map(record => ({ root: record.get("root"), neighbor: record.get("neighbor"), relationship: record.get("relationship") })));
    } finally {
      await session.close();
    }
  }

  async expand(input: { tenantId: string; nodeId: string; limit: number }) {
    const session = this.getDriver().session({ database: env.NEO4J_DATABASE });
    try {
      const result = await session.executeRead(tx => tx.run(
        "MATCH (root:FlowGuardNode {tenantId: $tenantId, nodeId: $nodeId}) OPTIONAL MATCH (root)-[relationship:RELATED_TO]-(neighbor:FlowGuardNode {tenantId: $tenantId}) RETURN root, neighbor, relationship LIMIT $limit",
        { tenantId: input.tenantId, nodeId: input.nodeId, limit: neo4j.int(input.limit) }
      ));
      return mapResult(result.records.map(record => ({ root: record.get("root"), neighbor: record.get("neighbor"), relationship: record.get("relationship") })));
    } finally {
      await session.close();
    }
  }

  async rebuildTenant(tenantId: string) {
    const leaseOwner = randomUUID();
    const now = new Date();
    await prisma.graphProjectionState.upsert({ where: { tenantId }, create: { tenantId }, update: { updatedAt: now } });
    const lease = await prisma.graphProjectionState.updateMany({
      where: { tenantId, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
      data: { leaseOwner, leaseExpiresAt: new Date(now.getTime() + 60_000) }
    });
    if (!lease.count) throw new GraphProjectionBusyError("A tenant graph projection is already running");
    const heartbeat = setInterval(() => {
      void prisma.graphProjectionState.updateMany({ where: { tenantId, leaseOwner }, data: { leaseExpiresAt: new Date(Date.now() + 60_000) } }).catch(() => undefined);
    }, 20_000);

    try {
      const data = await prisma.$transaction(async tx => {
      const appFilter = { application: { tenantId } };
      const institutionFilter = { tenantId };
      const [institutions, campuses, programmes, offerings, applications, workflowDefinitions, requirements, evidenceLinks, documents, extractions, deficiencies, reviews, inspections, assessments, decisions, approvals, obligations, identifiers, promoters] = await Promise.all([
        tx.institution.findMany({ where: institutionFilter, select: { id: true, name: true, institutionType: true, createdAt: true, promoterId: true, archivedAt: true } }),
        tx.campus.findMany({ where: { institution: { tenantId } }, select: { id: true, name: true, institutionId: true, createdAt: true } }),
        tx.programme.findMany({ where: { OR: [{ offerings: { some: { campus: { institution: { tenantId } } } } }, { applications: { some: { tenantId } } }] }, select: { id: true, name: true, discipline: true, createdAt: true } }),
        tx.courseOffering.findMany({ where: { campus: { institution: { tenantId } } }, select: { id: true, programmeId: true, campusId: true, academicYear: true, approvedIntake: true, createdAt: true } }),
        tx.application.findMany({ where: { tenantId }, select: { id: true, institutionId: true, campusId: true, programmeId: true, workflowId: true, applicationNumber: true, status: true, academicYear: true, createdAt: true, updatedAt: true } }),
        tx.workflowDefinition.findMany({ where: { applications: { some: { tenantId } } }, select: { id: true, category: true, version: true, active: true } }),
        tx.requirement.findMany({ where: { workflow: { applications: { some: { tenantId } } } }, select: { id: true, workflowId: true, code: true, mandatory: true } }),
        tx.requirementEvidence.findMany({ where: { document: { application: { tenantId } }, requirement: { workflow: { applications: { some: { tenantId } } } } }, select: { requirementId: true, documentId: true } }),
        tx.document.findMany({ where: appFilter, select: { id: true, applicationId: true, version: true, status: true, processingState: true, scanResult: true, mimeType: true, uploadedAt: true, updatedAt: true } }),
        tx.evidenceExtraction.findMany({ where: { document: appFilter }, select: { id: true, documentId: true, fieldName: true, confidence: true, pageNumber: true, humanVerified: true, verifiedAt: true, extractor: true, extractorVersion: true, confidenceBasis: true } }),
        tx.deficiency.findMany({ where: { tenantId }, select: { id: true, applicationId: true, code: true, status: true, raisedAt: true, responseSubmittedAt: true, closedAt: true } }),
        tx.review.findMany({ where: { tenantId }, select: { id: true, applicationId: true, status: true, startedAt: true, completedAt: true } }),
        tx.inspection.findMany({ where: { tenantId }, select: { id: true, applicationId: true, outcome: true, scheduledAt: true, completedAt: true, createdAt: true } }),
        tx.evcAssessment.findMany({ where: { tenantId }, select: { id: true, applicationId: true, outcome: true, committeeReference: true, assessedAt: true, createdAt: true } }),
        tx.formalDecision.findMany({ where: { application: { tenantId } }, select: { id: true, applicationId: true, outcome: true, issuedAt: true, authority: true } }),
        tx.approval.findMany({ where: { institution: { tenantId } }, select: { id: true, institutionId: true, decisionId: true, programmeName: true, academicYear: true, validFrom: true, validTo: true, verifiedAt: true } }),
        tx.obligation.findMany({ where: { institution: { tenantId } }, select: { id: true, institutionId: true, title: true, dueAt: true, status: true } }),
        tx.externalIdentifier.findMany({ where: { OR: [{ institution: { tenantId } }, { campus: { institution: { tenantId } } }, { application: { tenantId } }] }, select: { id: true, issuer: true, namespace: true, value: true, sourceReference: true, verifiedAt: true, institutionId: true, campusId: true, applicationId: true } }),
        tx.promoter.findMany({ where: { institutions: { some: institutionFilter } }, select: { id: true, name: true, legalType: true, createdAt: true } })
      ]);

      const nodes = new Map<string, NodeInput>();
      const edges = new Map<string, EdgeInput>();
      const addNode = (type: GraphNodeType, id: string, label: string, sourceTable: string, details: Record<string, string | number | boolean | null>, status?: string) => {
        const graphId = nodeId(type, id);
        nodes.set(graphId, { id: graphId, type, label, ...(status ? { status } : {}), details, sourceTable, sourceId: id, tenantId });
        return graphId;
      };
      const addEdge = (source: string, target: string, type: string, sourceTable: string, sourceField: string, verificationState: EdgeInput["verificationState"] = "VERIFIED_FOREIGN_KEY") => {
        const id = `${source}|${type}|${target}`;
        edges.set(id, { id, source, target, type, sourceTable, sourceField, confidence: 1, verificationState });
      };

      for (const item of promoters) addNode("PROMOTER", item.id, item.name, "Promoter", { legalType: item.legalType, createdAt: item.createdAt.toISOString() });
      for (const item of institutions) {
        const id = addNode("INSTITUTION", item.id, item.name, "Institution", { institutionType: item.institutionType, createdAt: item.createdAt.toISOString() }, item.archivedAt ? "ARCHIVED" : undefined);
        if (item.promoterId) addEdge(nodeId("PROMOTER", item.promoterId), id, "PROMOTES", "Institution", "promoterId");
      }
      for (const item of campuses) {
        const id = addNode("CAMPUS", item.id, item.name, "Campus", { createdAt: item.createdAt.toISOString() });
        addEdge(nodeId("INSTITUTION", item.institutionId), id, "HAS_CAMPUS", "Campus", "institutionId");
      }
      for (const item of programmes) addNode("PROGRAMME", item.id, item.name, "Programme", { discipline: item.discipline, createdAt: item.createdAt.toISOString() });
      for (const item of offerings) {
        const id = addNode("COURSE_OFFERING", item.id, `${item.academicYear} offering`, "CourseOffering", { academicYear: item.academicYear, approvedIntake: item.approvedIntake, createdAt: item.createdAt.toISOString() });
        addEdge(nodeId("CAMPUS", item.campusId), id, "HOSTS_OFFERING", "CourseOffering", "campusId");
        addEdge(nodeId("PROGRAMME", item.programmeId), id, "OFFERED_AS", "CourseOffering", "programmeId");
      }
      for (const item of applications) {
        const id = addNode("APPLICATION", item.id, item.applicationNumber || `Application · ${item.academicYear}`, "Application", { applicationNumber: item.applicationNumber, academicYear: item.academicYear, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() }, item.status);
        addEdge(nodeId("INSTITUTION", item.institutionId), id, "HAS_APPLICATION", "Application", "institutionId");
        if (item.campusId) addEdge(nodeId("CAMPUS", item.campusId), id, "APPLICATION_FOR_CAMPUS", "Application", "campusId");
        if (item.programmeId) addEdge(nodeId("PROGRAMME", item.programmeId), id, "APPLICATION_FOR_PROGRAMME", "Application", "programmeId");
        const workflow = workflowDefinitions.find(value => value.id === item.workflowId);
        if (workflow) addEdge(id, nodeId("WORKFLOW", workflow.id), "USES_WORKFLOW", "Application", "workflowId");
        const offering = offerings.find(value => value.campusId === item.campusId && value.programmeId === item.programmeId && value.academicYear === item.academicYear);
        if (offering) addEdge(id, nodeId("COURSE_OFFERING", offering.id), "APPLIES_TO_OFFERING", "Application", "campusId+programmeId+academicYear", "EXACT_KEY_MATCH");
      }
      for (const item of workflowDefinitions) {
        const id = addNode("WORKFLOW", item.id, `${item.category} · v${item.version}`, "WorkflowDefinition", { category: item.category, version: item.version, active: item.active });
        for (const requirement of requirements.filter(value => value.workflowId === item.id)) addEdge(id, nodeId("REQUIREMENT", requirement.id), "HAS_REQUIREMENT", "Requirement", "workflowId");
      }
      for (const item of requirements) addNode("REQUIREMENT", item.id, item.code, "Requirement", { mandatory: item.mandatory });
      for (const item of documents) {
        const id = addNode("DOCUMENT", item.id, `Document · v${item.version}`, "Document", { version: item.version, status: item.status, processingState: item.processingState, scanResult: item.scanResult, mimeType: item.mimeType, uploadedAt: item.uploadedAt.toISOString() });
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_DOCUMENT", "Document", "applicationId");
      }
      for (const item of extractions) {
        const id = addNode("EVIDENCE_EXTRACTION", item.id, item.fieldName, "EvidenceExtraction", { confidence: item.confidence, confidenceBasis: item.confidenceBasis, pageNumber: item.pageNumber, humanVerified: item.humanVerified, verifiedAt: item.verifiedAt?.toISOString() ?? null, extractor: item.extractor, extractorVersion: item.extractorVersion });
        addEdge(nodeId("DOCUMENT", item.documentId), id, "HAS_EVIDENCE_EXTRACTION", "EvidenceExtraction", "documentId");
      }
      for (const link of evidenceLinks) addEdge(nodeId("REQUIREMENT", link.requirementId), nodeId("DOCUMENT", link.documentId), "EVIDENCED_BY_DOCUMENT", "RequirementEvidence", "documentId");
      for (const item of deficiencies) {
        const id = addNode("DEFICIENCY", item.id, item.code, "Deficiency", { raisedAt: item.raisedAt.toISOString(), responseSubmittedAt: item.responseSubmittedAt?.toISOString() ?? null, closedAt: item.closedAt?.toISOString() ?? null }, item.status);
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_DEFICIENCY", "Deficiency", "applicationId");
      }
      for (const item of reviews) {
        const id = addNode("REVIEW", item.id, "Review", "Review", { startedAt: item.startedAt?.toISOString() ?? null, completedAt: item.completedAt?.toISOString() ?? null }, item.status);
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_REVIEW", "Review", "applicationId");
      }
      for (const item of inspections) {
        const id = addNode("INSPECTION", item.id, "Inspection", "Inspection", { outcome: item.outcome, scheduledAt: item.scheduledAt?.toISOString() ?? null, completedAt: item.completedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() }, item.outcome ?? undefined);
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_INSPECTION", "Inspection", "applicationId");
      }
      for (const item of assessments) {
        const id = addNode("EVC_ASSESSMENT", item.id, "EVC assessment", "EvcAssessment", { committeeReference: item.committeeReference, assessedAt: item.assessedAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() }, item.outcome ?? undefined);
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_EVC_ASSESSMENT", "EvcAssessment", "applicationId");
      }
      for (const item of decisions) {
        const id = addNode("FORMAL_DECISION", item.id, "Formal decision", "FormalDecision", { outcome: item.outcome, issuedAt: item.issuedAt.toISOString(), authority: item.authority }, item.outcome);
        addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_FORMAL_DECISION", "FormalDecision", "applicationId");
      }
      for (const item of approvals) {
        const id = addNode("APPROVAL", item.id, item.programmeName, "Approval", { academicYear: item.academicYear, validFrom: item.validFrom?.toISOString() ?? null, validTo: item.validTo?.toISOString() ?? null, verifiedAt: item.verifiedAt?.toISOString() ?? null });
        addEdge(nodeId("INSTITUTION", item.institutionId), id, "HAS_APPROVAL", "Approval", "institutionId");
        if (item.decisionId) addEdge(nodeId("FORMAL_DECISION", item.decisionId), id, "RESULTED_IN_APPROVAL", "Approval", "decisionId");
      }
      for (const item of obligations) {
        const id = addNode("OBLIGATION", item.id, item.title, "Obligation", { dueAt: item.dueAt?.toISOString() ?? null }, item.status);
        addEdge(nodeId("INSTITUTION", item.institutionId), id, "HAS_OBLIGATION", "Obligation", "institutionId");
      }
      for (const item of identifiers) {
        const id = addNode("EXTERNAL_IDENTIFIER", item.id, `${item.issuer} · ${item.namespace}`, "ExternalIdentifier", { issuer: item.issuer, namespace: item.namespace, value: item.value, sourceReference: item.sourceReference, verifiedAt: item.verifiedAt?.toISOString() ?? null });
        if (item.institutionId) addEdge(nodeId("INSTITUTION", item.institutionId), id, "HAS_EXTERNAL_IDENTIFIER", "ExternalIdentifier", "institutionId");
        if (item.campusId) addEdge(nodeId("CAMPUS", item.campusId), id, "HAS_EXTERNAL_IDENTIFIER", "ExternalIdentifier", "campusId");
        if (item.applicationId) addEdge(nodeId("APPLICATION", item.applicationId), id, "HAS_EXTERNAL_IDENTIFIER", "ExternalIdentifier", "applicationId");
      }
      return { nodes: [...nodes.values()], edges: [...edges.values()] };
      }, { isolationLevel: "RepeatableRead" });

      const state = await prisma.graphProjectionState.findUnique({ where: { tenantId } });
      const version = (state?.version ?? 0) + 1;
      const driver = this.getDriver();
      const session = driver.session({ database: env.NEO4J_DATABASE });
      try {
        await session.run("CREATE CONSTRAINT flowguard_node_identity IF NOT EXISTS FOR (node:FlowGuardNode) REQUIRE (node.tenantId, node.nodeId) IS UNIQUE");
        await session.executeWrite(async tx => {
          await tx.run("MATCH (node:FlowGuardNode {tenantId: $tenantId}) DETACH DELETE node", { tenantId });
          if (data.nodes.length) {
            await tx.run(
              "UNWIND $nodes AS item CREATE (:FlowGuardNode {tenantId: item.tenantId, nodeId: item.id, type: item.type, label: item.label, status: item.status, detailsJson: item.detailsJson, sourceTable: item.sourceTable, sourceId: item.sourceId, projectionVersion: $version})",
              { nodes: data.nodes.map(item => ({ ...item, detailsJson: JSON.stringify(item.details), status: item.status ?? null })), version: neo4j.int(version) }
            );
          }
          if (data.edges.length) {
            await tx.run(
              "UNWIND $edges AS item MATCH (source:FlowGuardNode {tenantId: $tenantId, nodeId: item.source}) MATCH (target:FlowGuardNode {tenantId: $tenantId, nodeId: item.target}) CREATE (source)-[:RELATED_TO {edgeId: item.id, type: item.type, sourceTable: item.sourceTable, sourceField: item.sourceField, confidence: item.confidence, verificationState: item.verificationState, sourceNodeId: item.source, targetNodeId: item.target}]->(target)",
              { tenantId, edges: data.edges }
            );
          }
        });
      } finally {
        await session.close();
      }
      await prisma.graphProjectionState.update({
        where: { tenantId },
        data: { version, nodeCount: data.nodes.length, edgeCount: data.edges.length, lastSyncedAt: new Date(), lastError: null }
      });
      return { version, nodeCount: data.nodes.length, edgeCount: data.edges.length };
    } finally {
      clearInterval(heartbeat);
      await prisma.graphProjectionState.updateMany({ where: { tenantId, leaseOwner }, data: { leaseOwner: null, leaseExpiresAt: null } });
    }
  }

  async close() {
    if (this.driver) await this.driver.close();
    this.driver = null;
  }
}

export const graphStore: GraphStore = new Neo4jGraphStore();

export function graphNodeType(value: string): GraphNodeType | undefined {
  const allowed: GraphNodeType[] = ["PROMOTER", "INSTITUTION", "CAMPUS", "PROGRAMME", "COURSE_OFFERING", "APPLICATION", "WORKFLOW", "REQUIREMENT", "DOCUMENT", "EVIDENCE_EXTRACTION", "DEFICIENCY", "REVIEW", "INSPECTION", "EVC_ASSESSMENT", "FORMAL_DECISION", "APPROVAL", "OBLIGATION", "EXTERNAL_IDENTIFIER"];
  return allowed.includes(value as GraphNodeType) ? value as GraphNodeType : undefined;
}
