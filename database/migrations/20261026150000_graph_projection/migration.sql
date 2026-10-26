CREATE TABLE "GraphProjectionState" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "nodeCount" INTEGER NOT NULL DEFAULT 0,
  "edgeCount" INTEGER NOT NULL DEFAULT 0,
  "lastSyncedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GraphProjectionState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GraphProjectionState_tenantId_key" ON "GraphProjectionState"("tenantId");
ALTER TABLE "GraphProjectionState" ADD CONSTRAINT "GraphProjectionState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "OutboxEvent_eventType_aggregateId_processedAt_availableAt_idx" ON "OutboxEvent"("eventType", "aggregateId", "processedAt", "availableAt");

CREATE OR REPLACE FUNCTION flowguard_enqueue_graph_refresh(p_tenant_id TEXT) RETURNS VOID AS $$
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO "OutboxEvent" ("id", "eventType", "aggregateType", "aggregateId", "payload", "idempotencyKey", "createdAt")
  VALUES ('graph_' || md5(p_tenant_id || ':' || txid_current()::text || ':' || clock_timestamp()::text || random()::text), 'GRAPH_REFRESH_REQUESTED', 'Tenant', p_tenant_id,
          jsonb_build_object('tenantId', p_tenant_id), 'graph-refresh:' || p_tenant_id || ':' || txid_current()::text, CURRENT_TIMESTAMP)
  ON CONFLICT ("idempotencyKey") DO NOTHING;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION flowguard_graph_tenants_for_row(p_table_name TEXT, p_row JSONB) RETURNS VOID AS $$
DECLARE
  tenant_id TEXT;
  row_id TEXT := p_row->>'id';
BEGIN
  IF row_id IS NULL THEN
    RETURN;
  END IF;
  IF p_table_name IN ('Institution', 'Application', 'Deficiency', 'Review', 'Inspection', 'EvcAssessment') THEN
    PERFORM flowguard_enqueue_graph_refresh(p_row->>'tenantId');
  ELSIF p_table_name = 'Campus' THEN
    SELECT "tenantId" INTO tenant_id FROM "Institution" WHERE "id" = p_row->>'institutionId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name = 'CourseOffering' THEN
    SELECT i."tenantId" INTO tenant_id FROM "Campus" c JOIN "Institution" i ON i."id" = c."institutionId" WHERE c."id" = p_row->>'campusId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name = 'Programme' THEN
    FOR tenant_id IN
      SELECT DISTINCT i."tenantId" FROM "CourseOffering" o JOIN "Campus" c ON c."id" = o."campusId" JOIN "Institution" i ON i."id" = c."institutionId" WHERE o."programmeId" = row_id
      UNION
      SELECT DISTINCT a."tenantId" FROM "Application" a WHERE a."programmeId" = row_id
    LOOP
      PERFORM flowguard_enqueue_graph_refresh(tenant_id);
    END LOOP;
  ELSIF p_table_name = 'WorkflowDefinition' THEN
    FOR tenant_id IN SELECT DISTINCT "tenantId" FROM "Application" WHERE "workflowId" = row_id LOOP
      PERFORM flowguard_enqueue_graph_refresh(tenant_id);
    END LOOP;
  ELSIF p_table_name = 'Requirement' THEN
    FOR tenant_id IN SELECT DISTINCT a."tenantId" FROM "Application" a WHERE a."workflowId" = p_row->>'workflowId' LOOP
      PERFORM flowguard_enqueue_graph_refresh(tenant_id);
    END LOOP;
  ELSIF p_table_name = 'RequirementEvidence' THEN
    FOR tenant_id IN
      SELECT DISTINCT document_application."tenantId"
      FROM "Document" d
      JOIN "Application" document_application ON document_application."id" = d."applicationId"
      JOIN "Requirement" r ON r."id" = p_row->>'requirementId'
      JOIN "Application" workflow_application ON workflow_application."workflowId" = r."workflowId" AND workflow_application."tenantId" = document_application."tenantId"
      WHERE d."id" = p_row->>'documentId'
    LOOP
      PERFORM flowguard_enqueue_graph_refresh(tenant_id);
    END LOOP;
  ELSIF p_table_name = 'EvidenceExtraction' THEN
    SELECT a."tenantId" INTO tenant_id FROM "Document" d JOIN "Application" a ON a."id" = d."applicationId" WHERE d."id" = p_row->>'documentId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name = 'Promoter' THEN
    FOR tenant_id IN SELECT DISTINCT "tenantId" FROM "Institution" WHERE "promoterId" = row_id LOOP
      PERFORM flowguard_enqueue_graph_refresh(tenant_id);
    END LOOP;
  ELSIF p_table_name = 'Document' THEN
    SELECT "tenantId" INTO tenant_id FROM "Application" WHERE "id" = p_row->>'applicationId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name = 'ExternalIdentifier' THEN
    SELECT candidate."tenantId" INTO tenant_id FROM (
      SELECT i."tenantId" FROM "Institution" i WHERE i."id" = p_row->>'institutionId'
      UNION ALL SELECT i."tenantId" FROM "Campus" c JOIN "Institution" i ON i."id" = c."institutionId" WHERE c."id" = p_row->>'campusId'
      UNION ALL SELECT a."tenantId" FROM "Application" a WHERE a."id" = p_row->>'applicationId'
    ) AS candidate LIMIT 1;
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name = 'FormalDecision' THEN
    SELECT "tenantId" INTO tenant_id FROM "Application" WHERE "id" = p_row->>'applicationId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  ELSIF p_table_name IN ('Approval', 'Obligation') THEN
    SELECT "tenantId" INTO tenant_id FROM "Institution" WHERE "id" = p_row->>'institutionId';
    PERFORM flowguard_enqueue_graph_refresh(tenant_id);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION flowguard_graph_outbox_trigger() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM flowguard_graph_tenants_for_row(TG_TABLE_NAME, to_jsonb(OLD));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM flowguard_graph_tenants_for_row(TG_TABLE_NAME, to_jsonb(NEW));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Institution', 'Promoter', 'Campus', 'Programme', 'CourseOffering', 'Application', 'WorkflowDefinition', 'Requirement', 'RequirementEvidence', 'EvidenceExtraction', 'ExternalIdentifier', 'Document', 'Deficiency', 'Review', 'Inspection', 'EvcAssessment', 'FormalDecision', 'Approval', 'Obligation'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION flowguard_graph_outbox_trigger()', 'flowguard_graph_' || table_name, table_name);
  END LOOP;
END;
$$;
