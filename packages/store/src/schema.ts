import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ActiveWriterError } from "./errors.js";

export const SCHEMA_VERSION = 1;

const SCHEMA_MARKER_SCHEMA = `
CREATE TABLE schema_version (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version >= 1),
        baseline_id TEXT NOT NULL CHECK (
          length(baseline_id) = 64 AND baseline_id NOT GLOB '*[^0-9a-f]*'
        ),
        initialized_at INTEGER NOT NULL
      ) STRICT;
`;

export const BASELINE_SCHEMA = `
CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        mime_type TEXT NOT NULL,
        file_name TEXT,
        storage_key TEXT NOT NULL,
        session_id TEXT REFERENCES product_sessions(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        backend_instance_generation INTEGER CHECK (
          backend_instance_generation IS NULL OR backend_instance_generation >= 0
        ),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        error_json TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(run_id, ordinal)
      ) STRICT;

CREATE TABLE backend_instance_generations (
        backend_id TEXT PRIMARY KEY,
        adapter_kind TEXT NOT NULL CHECK (
          length(trim(adapter_kind)) BETWEEN 1 AND 256
          AND adapter_kind = trim(adapter_kind)
        ),
        high_water_generation INTEGER NOT NULL CHECK (
          high_water_generation BETWEEN 0 AND 9007199254740991
        ),
        current_generation INTEGER CHECK (
          current_generation IS NULL OR (
            current_generation BETWEEN 0 AND high_water_generation
          )
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(backend_id, adapter_kind, current_generation)
      ) STRICT;

CREATE TABLE backends (
        id TEXT PRIMARY KEY,
        adapter_kind TEXT NOT NULL,
        instance_generation INTEGER NOT NULL CHECK (instance_generation >= 0),
        display_name TEXT NOT NULL,
        version TEXT NOT NULL,
        health TEXT NOT NULL CHECK (health IN ('healthy', 'degraded', 'unavailable')),
        installation_state TEXT NOT NULL CHECK (installation_state IN ('not_installed', 'installing', 'installed', 'update_available', 'error')),
        authentication_state TEXT NOT NULL CHECK (authentication_state IN ('not_required', 'signed_out', 'pending', 'authenticated', 'expired', 'refreshing', 'error')),
        error_json TEXT,
        capabilities_json TEXT NOT NULL,
        providers_json TEXT NOT NULL,
        models_json TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        FOREIGN KEY(id, adapter_kind, instance_generation)
          REFERENCES backend_instance_generations(backend_id, adapter_kind, current_generation)
          DEFERRABLE INITIALLY DEFERRED
      ) STRICT;

CREATE TRIGGER backend_instance_adapter_kind_immutable
BEFORE UPDATE OF adapter_kind ON backend_instance_generations
WHEN NEW.adapter_kind <> OLD.adapter_kind
BEGIN
  SELECT RAISE(ABORT, 'Backend Adapter kind is immutable');
END;

CREATE TRIGGER backend_instance_high_water_monotonic
BEFORE UPDATE OF high_water_generation ON backend_instance_generations
WHEN NEW.high_water_generation < OLD.high_water_generation
BEGIN
  SELECT RAISE(ABORT, 'Backend generation high-water mark cannot move backwards');
END;

CREATE TRIGGER backend_instance_current_generation_monotonic
BEFORE UPDATE OF current_generation ON backend_instance_generations
WHEN OLD.current_generation IS NOT NULL
  AND (NEW.current_generation IS NULL OR NEW.current_generation < OLD.current_generation)
BEGIN
  SELECT RAISE(ABORT, 'Backend current generation cannot move backwards');
END;

CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        auth_key_digest TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE device_control_relations (
        controller_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        target_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        outbound_enabled INTEGER NOT NULL CHECK (outbound_enabled IN (0, 1)),
        inbound_allowed INTEGER NOT NULL CHECK (inbound_allowed IN (0, 1)),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(controller_device_id, target_device_id),
        CHECK (controller_device_id <> target_device_id)
      ) STRICT;

CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('unspecified', 'web', 'desktop', 'service')),
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        remote_control_enabled INTEGER NOT NULL CHECK (remote_control_enabled IN (0, 1)),
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE diagnostics (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'error')),
        component TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE events (
        global_cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        session_sequence INTEGER NOT NULL CHECK (session_sequence >= 1),
        emitted_at INTEGER NOT NULL,
        backend_id TEXT NOT NULL REFERENCES backends(id) ON DELETE RESTRICT,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        trace_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        namespace TEXT,
        metadata_json TEXT,
        UNIQUE(session_id, session_sequence)
      ) STRICT;

CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        operation_id TEXT REFERENCES operations(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
        payload_json TEXT NOT NULL,
        decision_json TEXT,
        dismissal_reason TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE local_model_pull_checkpoints (
        owner_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
        model_key TEXT NOT NULL CHECK (
          length(trim(model_key)) BETWEEN 1 AND 512
          AND instr(model_key, char(0)) = 0
          AND instr(model_key, char(10)) = 0
          AND instr(model_key, char(13)) = 0
        ),
        model_name TEXT NOT NULL CHECK (
          length(trim(model_name)) BETWEEN 1 AND 512
          AND instr(model_name, char(0)) = 0
          AND instr(model_name, char(10)) = 0
          AND instr(model_name, char(13)) = 0
        ),
        completed_bytes INTEGER CHECK (completed_bytes IS NULL OR completed_bytes >= 0),
        total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes > 0),
        percent INTEGER CHECK (percent IS NULL OR percent BETWEEN 0 AND 100),
        digests_json TEXT NOT NULL CHECK (length(digests_json) <= 32768),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, runtime_id, model_key),
        FOREIGN KEY(owner_id, runtime_id)
          REFERENCES local_runtime_owners(owner_id, runtime_id) ON DELETE CASCADE,
        CHECK (completed_bytes IS NULL OR total_bytes IS NULL OR completed_bytes <= total_bytes)
      ) STRICT;

CREATE TABLE local_runtime_installations (
        owner_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
        operation_id TEXT NOT NULL CHECK (
          length(trim(operation_id)) BETWEEN 1 AND 128
          AND instr(operation_id, char(0)) = 0
        ),
        state TEXT NOT NULL CHECK (state IN ('installing', 'installed', 'failed', 'cancelled')),
        version TEXT CHECK (
          version IS NULL OR (
            length(version) BETWEEN 1 AND 64
            AND instr(version, char(0)) = 0
          )
        ),
        archive_sha256 TEXT CHECK (
          archive_sha256 IS NULL OR (
            length(archive_sha256) = 64
            AND archive_sha256 NOT GLOB '*[^0-9a-f]*'
          )
        ),
        public_error_code TEXT CHECK (
          public_error_code IS NULL OR (
            length(public_error_code) BETWEEN 1 AND 64
            AND public_error_code NOT GLOB '*[^A-Z0-9_]*'
          )
        ),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= started_at),
        lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at >= heartbeat_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, runtime_id),
        FOREIGN KEY(owner_id, runtime_id)
          REFERENCES local_runtime_owners(owner_id, runtime_id) ON DELETE CASCADE,
        CHECK (
          (state = 'installing' AND version IS NULL AND archive_sha256 IS NULL
            AND public_error_code IS NULL AND lease_expires_at > heartbeat_at)
          OR (state = 'installed' AND version IS NOT NULL AND archive_sha256 IS NOT NULL
            AND public_error_code IS NULL)
          OR (state IN ('failed', 'cancelled') AND version IS NULL AND archive_sha256 IS NULL
            AND public_error_code IS NOT NULL)
        )
      ) STRICT;

CREATE TABLE local_runtime_owners (
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
          AND instr(owner_id, char(10)) = 0
          AND instr(owner_id, char(13)) = 0
        ),
        runtime_id TEXT NOT NULL CHECK (
          length(trim(runtime_id)) BETWEEN 1 AND 64
          AND instr(runtime_id, char(0)) = 0
          AND instr(runtime_id, '/') = 0
          AND instr(runtime_id, '\\') = 0
        ),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        activated_at INTEGER NOT NULL CHECK (activated_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= activated_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, runtime_id)
      ) STRICT;

CREATE TABLE local_runtime_provider_bindings (
        owner_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK (owner_generation >= 0),
        provider_id TEXT NOT NULL CHECK (
          length(trim(provider_id)) BETWEEN 1 AND 256
          AND instr(provider_id, char(0)) = 0
        ),
        provider_version TEXT NOT NULL CHECK (
          length(provider_version) BETWEEN 1 AND 32
          AND provider_version NOT GLOB '*[^0-9]*'
        ),
        model_ids_json TEXT NOT NULL CHECK (length(model_ids_json) <= 262144),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, runtime_id),
        UNIQUE(owner_id, provider_id),
        FOREIGN KEY(owner_id, runtime_id)
          REFERENCES local_runtime_owners(owner_id, runtime_id) ON DELETE CASCADE
      ) STRICT;

CREATE TABLE maker_memory_entries (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'feedback', 'project', 'reference', 'digest')),
        backend_id TEXT REFERENCES backends(id) ON DELETE RESTRICT CHECK (
          backend_id IS NULL
          OR (
            length(trim(backend_id)) BETWEEN 1 AND 256
            AND backend_id GLOB '[A-Za-z0-9]*'
            AND backend_id NOT GLOB '*[^A-Za-z0-9._:-]*'
          )
        ),
        slug TEXT NOT NULL CHECK (
          length(slug) BETWEEN 1 AND 64
          AND slug NOT GLOB '*[^a-z0-9_-]*'
        ),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 100 AND instr(title, char(0)) = 0),
        description TEXT NOT NULL CHECK (
          length(trim(description)) BETWEEN 1 AND 200
          AND instr(description, char(0)) = 0
          AND instr(description, char(10)) = 0
          AND instr(description, char(13)) = 0
        ),
        body TEXT NOT NULL CHECK (
          length(body) BETWEEN 1 AND 8192
          AND instr(body, char(0)) = 0
        ),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (kind = 'digest' AND backend_id IS NOT NULL)
          OR (kind <> 'digest' AND backend_id IS NULL)
        ),
        UNIQUE(target_id, kind, slug)
      ) STRICT;

CREATE VIRTUAL TABLE maker_memory_fts USING fts5(
        entry_id UNINDEXED,
        target_id UNINDEXED,
        kind UNINDEXED,
        title,
        description,
        body,
        tokenize = 'trigram'
      );

CREATE TABLE message_embedding_jobs (
        event_cursor INTEGER PRIMARY KEY REFERENCES events(global_cursor) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        scheduled_at INTEGER NOT NULL,
        claimed_at INTEGER,
        claim_token TEXT,
        error_code TEXT
      ) STRICT;

CREATE TABLE message_embedding_records (
        event_cursor INTEGER PRIMARY KEY REFERENCES events(global_cursor) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        provider_generation_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        embedded_at INTEGER NOT NULL
      ) STRICT;

CREATE TABLE message_embedding_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        cutoff_cursor INTEGER NOT NULL CHECK (cutoff_cursor >= 0),
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        provider_id TEXT,
        cutoff_initialized INTEGER NOT NULL CHECK (cutoff_initialized IN (0, 1)),
        provider_generation_id TEXT
      ) STRICT;

CREATE TABLE message_event_tombstones (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        deletion_operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
        deleted_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE native_history_event_identities (
        event_cursor INTEGER PRIMARY KEY REFERENCES events(global_cursor) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        binding_fingerprint TEXT NOT NULL CHECK (
          binding_fingerprint GLOB 'sha256:*'
          AND length(binding_fingerprint) = 71
        ),
        entry_id TEXT NOT NULL,
        parent_entry_id TEXT
      ) STRICT;

CREATE TABLE native_history_canonical_identities (
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        binding_fingerprint TEXT NOT NULL CHECK (
          binding_fingerprint GLOB 'sha256:*'
          AND length(binding_fingerprint) = 71
        ),
        entry_id TEXT NOT NULL,
        event_cursor INTEGER NOT NULL UNIQUE
          REFERENCES native_history_event_identities(event_cursor) ON DELETE CASCADE,
        parent_entry_id TEXT,
        PRIMARY KEY(session_id, binding_fingerprint, entry_id)
      ) WITHOUT ROWID, STRICT;

CREATE TABLE native_history_current_markers (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        event_cursor INTEGER NOT NULL UNIQUE REFERENCES events(global_cursor) ON DELETE CASCADE,
        native_opaque_ref TEXT NOT NULL,
        binding_fingerprint TEXT NOT NULL CHECK (
          binding_fingerprint GLOB 'sha256:*'
          AND length(binding_fingerprint) = 71
        ),
        leaf_id TEXT
      ) STRICT;

CREATE TABLE native_history_active_entries (
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        marker_cursor INTEGER NOT NULL REFERENCES events(global_cursor) ON DELETE CASCADE,
        binding_fingerprint TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        PRIMARY KEY(session_id, marker_cursor, entry_id),
        FOREIGN KEY(session_id) REFERENCES native_history_current_markers(session_id) ON DELETE CASCADE
      ) WITHOUT ROWID, STRICT;

CREATE VIRTUAL TABLE message_search_fts USING fts5(
        event_id UNINDEXED,
        visible_text,
        tokenize = 'trigram'
      );

CREATE TABLE model_price_overrides (
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
          AND instr(owner_id, char(10)) = 0
          AND instr(owner_id, char(13)) = 0
        ),
        backend_id TEXT NOT NULL CHECK (
          length(trim(backend_id)) BETWEEN 1 AND 256
          AND instr(backend_id, char(0)) = 0
        ),
        provider_id TEXT NOT NULL CHECK (
          length(trim(provider_id)) BETWEEN 1 AND 512
          AND instr(provider_id, char(0)) = 0
        ),
        model_id TEXT NOT NULL CHECK (
          length(trim(model_id)) BETWEEN 1 AND 512
          AND instr(model_id, char(0)) = 0
        ),
        currency_code TEXT NOT NULL CHECK (currency_code IN ('USD', 'CNY')),
        input_cost_micros_per_million INTEGER NOT NULL
          CHECK (input_cost_micros_per_million >= 0),
        output_cost_micros_per_million INTEGER NOT NULL
          CHECK (output_cost_micros_per_million >= 0),
        cache_read_cost_micros_per_million INTEGER
          CHECK (cache_read_cost_micros_per_million IS NULL OR cache_read_cost_micros_per_million >= 0),
        cache_write_cost_micros_per_million INTEGER
          CHECK (cache_write_cost_micros_per_million IS NULL OR cache_write_cost_micros_per_million >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, backend_id, provider_id, model_id)
      ) STRICT;

CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        completion_mode TEXT NOT NULL CHECK (completion_mode IN ('transactional', 'external_effect')),
        status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
        response_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE pairings (
        id TEXT PRIMARY KEY,
        code_digest TEXT NOT NULL UNIQUE,
        label TEXT,
        device_id TEXT,
        device_name TEXT,
        device_kind TEXT CHECK (device_kind IS NULL OR device_kind IN ('unspecified', 'web', 'desktop', 'service')),
        device_platform TEXT,
        device_app_version TEXT,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_connection_id TEXT REFERENCES connections(id),
        created_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (device_id IS NULL AND device_name IS NULL AND device_kind IS NULL AND device_platform IS NULL AND device_app_version IS NULL)
          OR (device_id IS NOT NULL AND device_name IS NOT NULL AND device_kind IS NOT NULL AND device_platform IS NOT NULL AND device_app_version IS NOT NULL)
        )
      ) STRICT;

CREATE TABLE product_sessions (
        id TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL REFERENCES backends(id) ON DELETE RESTRICT,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        native_opaque_ref TEXT NOT NULL,
        native_binding_fingerprint TEXT NOT NULL CHECK (
          native_binding_fingerprint GLOB 'sha256:*'
          AND length(native_binding_fingerprint) = 71
        ),
        native_session_id TEXT,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        deleted_at INTEGER,
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('ask', 'auto', 'bypassPermissions')),
        plan_mode INTEGER NOT NULL CHECK (plan_mode IN (0, 1)),
        provider_id TEXT,
        model_id TEXT,
        effort TEXT,
        fast_mode INTEGER NOT NULL CHECK (fast_mode IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1), append_system_prompt TEXT
        CHECK (
          append_system_prompt IS NULL
          OR (length(append_system_prompt) <= 8000 AND instr(append_system_prompt, char(0)) = 0)
        ), remote_host_id TEXT CHECK (
        remote_host_id IS NULL OR (
          length(trim(remote_host_id)) BETWEEN 1 AND 256
          AND instr(remote_host_id, char(0)) = 0
          AND instr(remote_host_id, '*') = 0
          AND instr(remote_host_id, '?') = 0
          AND substr(remote_host_id, 1, 1) <> '!'
        )
      ), remote_workspace_root TEXT CHECK (
        remote_workspace_root IS NULL OR (
          length(remote_workspace_root) BETWEEN 1 AND 16384
          AND substr(remote_workspace_root, 1, 1) = '/'
          AND instr(remote_workspace_root, char(0)) = 0
        )
      ), title_source TEXT NOT NULL
        CHECK (title_source IN ('draft', 'attachment', 'placeholder', 'automatic', 'manual')), task_summary TEXT CHECK (
        task_summary IS NULL OR (
          length(trim(task_summary)) BETWEEN 1 AND 26
          AND instr(task_summary, char(0)) = 0
        )
      ), summary_source_cursor INTEGER CHECK (
        summary_source_cursor IS NULL OR summary_source_cursor >= 0
      ), summary_updated_at INTEGER CHECK (
        summary_updated_at IS NULL OR summary_updated_at >= 0
      ), project_id TEXT REFERENCES targets(id) ON DELETE SET NULL,
        automation_schedule_id TEXT,
        automation_schedule_name TEXT,
        automation_run_id TEXT,
        derivation_kind TEXT CHECK (derivation_kind IS NULL OR derivation_kind IN ('fork', 'clone')),
        derivation_source_session_id TEXT,
        derivation_source_message_id TEXT,
        derivation_source_event_id TEXT,
        CHECK (
          (automation_schedule_id IS NULL AND automation_schedule_name IS NULL AND automation_run_id IS NULL)
          OR (
            automation_schedule_id IS NOT NULL
            AND automation_run_id IS NOT NULL
            AND length(trim(automation_schedule_id)) BETWEEN 1 AND 256
            AND length(automation_run_id) BETWEEN 1 AND 256
            AND instr(automation_schedule_id, char(0)) = 0
            AND instr(automation_run_id, char(0)) = 0
            AND (
              automation_schedule_name IS NULL
              OR (length(trim(automation_schedule_name)) BETWEEN 1 AND 256 AND instr(automation_schedule_name, char(0)) = 0)
            )
          )
        ),
        CHECK (
          (derivation_kind IS NULL AND derivation_source_session_id IS NULL
            AND derivation_source_message_id IS NULL AND derivation_source_event_id IS NULL)
          OR (
            derivation_kind IS NOT NULL
            AND derivation_source_session_id IS NOT NULL
            AND length(trim(derivation_source_session_id)) BETWEEN 1 AND 1024
            AND instr(derivation_source_session_id, char(0)) = 0
            AND (
              (derivation_source_message_id IS NULL AND derivation_source_event_id IS NULL)
              OR (
                derivation_source_message_id IS NOT NULL
                AND derivation_source_event_id IS NOT NULL
                AND length(derivation_source_message_id) BETWEEN 1 AND 1024
                AND length(derivation_source_event_id) BETWEEN 1 AND 1024
                AND instr(derivation_source_message_id, char(0)) = 0
                AND instr(derivation_source_event_id, char(0)) = 0
              )
            )
          )
        ),
        UNIQUE(id, backend_id, target_id)
      ) STRICT;

CREATE TABLE queue_controls (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        pause_reason TEXT,
        paused_at INTEGER,
        paused_by_connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
        interaction_lock_token TEXT,
        interaction_lock_connection_id TEXT,
        interaction_lock_expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (interaction_lock_token IS NULL AND interaction_lock_connection_id IS NULL AND interaction_lock_expires_at IS NULL)
          OR (
            interaction_lock_token IS NOT NULL
            AND interaction_lock_connection_id IS NOT NULL
            AND interaction_lock_expires_at IS NOT NULL
            AND
            length(interaction_lock_token) BETWEEN 16 AND 256
            AND instr(interaction_lock_token, char(0)) = 0
            AND length(interaction_lock_connection_id) BETWEEN 1 AND 1024
            AND instr(interaction_lock_connection_id, char(0)) = 0
            AND interaction_lock_expires_at >= 0
          )
        )
      ) STRICT;

CREATE TABLE queue_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
        disposition TEXT NOT NULL CHECK (disposition IN ('prompt', 'steer', 'follow_up')),
        state TEXT NOT NULL CHECK (state IN ('accepted', 'dispatching', 'backend_accepted', 'dispatch_unknown', 'completed', 'cancelled', 'failed')),
        backend_instance_generation INTEGER CHECK (
          backend_instance_generation IS NULL OR backend_instance_generation >= 0
        ),
        body_hash TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        backend_accepted_at INTEGER,
        completed_at INTEGER,
        error_json TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        execution_overrides_json TEXT,
        position INTEGER NOT NULL,
        edit_lock_token TEXT,
        edit_lock_connection_id TEXT,
        edit_lock_expires_at INTEGER,
        CHECK (
          state NOT IN ('dispatching', 'backend_accepted', 'dispatch_unknown', 'completed')
          OR (
            attempt_id IS NOT NULL
            AND backend_instance_generation IS NOT NULL
          )
        ),
        CHECK (
          backend_instance_generation IS NULL OR attempt_id IS NOT NULL
        ),
        CHECK (
          (edit_lock_token IS NULL AND edit_lock_connection_id IS NULL AND edit_lock_expires_at IS NULL)
          OR (
            edit_lock_token IS NOT NULL
            AND edit_lock_connection_id IS NOT NULL
            AND edit_lock_expires_at IS NOT NULL
            AND
            length(edit_lock_token) BETWEEN 16 AND 256
            AND instr(edit_lock_token, char(0)) = 0
            AND length(edit_lock_connection_id) BETWEEN 1 AND 1024
            AND instr(edit_lock_connection_id, char(0)) = 0
            AND edit_lock_expires_at >= 0
          )
        )
      ) STRICT;

CREATE TRIGGER attempts_backend_instance_generation_immutable
BEFORE UPDATE OF backend_instance_generation ON attempts
WHEN OLD.backend_instance_generation IS NOT NULL
  AND NEW.backend_instance_generation IS NOT OLD.backend_instance_generation
BEGIN
  SELECT RAISE(ABORT, 'Attempt Backend instance generation is immutable');
END;

CREATE TRIGGER queue_backend_instance_generation_immutable
BEFORE UPDATE OF backend_instance_generation ON queue_items
WHEN OLD.backend_instance_generation IS NOT NULL
  AND NEW.backend_instance_generation IS NOT OLD.backend_instance_generation
BEGIN
  SELECT RAISE(ABORT, 'Queue Backend instance generation is immutable');
END;

CREATE TRIGGER queue_dispatch_owner_insert
BEFORE INSERT ON queue_items
WHEN NEW.backend_instance_generation IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.run_id = NEW.run_id
      AND attempt.backend_instance_generation = NEW.backend_instance_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'Queue and Attempt Backend instance generations must match');
END;

CREATE TRIGGER queue_dispatch_owner_update
BEFORE UPDATE OF state, attempt_id, backend_instance_generation ON queue_items
WHEN NEW.backend_instance_generation IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM attempts attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.run_id = NEW.run_id
      AND attempt.backend_instance_generation = NEW.backend_instance_generation
  )
BEGIN
  SELECT RAISE(ABORT, 'Queue and Attempt Backend instance generations must match');
END;

CREATE TABLE remote_hosts (
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
          AND instr(owner_id, char(10)) = 0
          AND instr(owner_id, char(13)) = 0
        ),
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
        host_id TEXT NOT NULL CHECK (
          length(trim(host_id)) BETWEEN 1 AND 256
          AND instr(host_id, char(0)) = 0
          AND instr(host_id, '*') = 0
          AND instr(host_id, '?') = 0
          AND substr(host_id, 1, 1) <> '!'
        ),
        hostname TEXT NOT NULL CHECK (
          length(trim(hostname)) BETWEEN 1 AND 1024
          AND instr(hostname, char(0)) = 0
          AND instr(hostname, char(10)) = 0
          AND instr(hostname, char(13)) = 0
        ),
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        username TEXT NOT NULL CHECK (
          length(trim(username)) BETWEEN 1 AND 256
          AND instr(username, char(0)) = 0
          AND instr(username, char(10)) = 0
          AND instr(username, char(13)) = 0
        ),
        source TEXT NOT NULL CHECK (source IN ('manual', 'ssh_config')),
        credential_reference_id TEXT CHECK (
          credential_reference_id IS NULL OR (
            length(credential_reference_id) BETWEEN 1 AND 512
            AND credential_reference_id = trim(credential_reference_id)
            AND substr(credential_reference_id, 1, 1) GLOB '[A-Za-z0-9]'
            AND credential_reference_id NOT GLOB '*[^A-Za-z0-9._:/@-]*'
          )
        ),
        trust_algorithm TEXT CHECK (
          trust_algorithm IS NULL OR (
            length(trust_algorithm) BETWEEN 1 AND 128
            AND trust_algorithm NOT GLOB '*[^A-Za-z0-9@._+-]*'
          )
        ),
        trust_fingerprint TEXT CHECK (
          trust_fingerprint IS NULL OR (
            length(trust_fingerprint) = 50
            AND substr(trust_fingerprint, 1, 7) = 'SHA256:'
            AND substr(trust_fingerprint, 8) NOT GLOB '*[^A-Za-z0-9+/]*'
          )
        ),
        trust_pinned_at INTEGER CHECK (trust_pinned_at IS NULL OR trust_pinned_at >= 0),
        status TEXT NOT NULL CHECK (status IN ('disconnected', 'connecting', 'authenticating', 'ready', 'failed')),
        status_changed_at INTEGER NOT NULL CHECK (status_changed_at >= 0),
        failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
          'aborted', 'authentication_failed', 'connection_failed', 'connection_timeout',
          'connector_protocol', 'connector_unavailable', 'host_key_changed',
          'host_key_conflict', 'host_key_invalid', 'host_key_missing',
          'host_key_store_corrupt', 'host_key_store_missing',
          'host_key_store_unreadable', 'host_key_store_write_failed'
        )),
        failure_retryable INTEGER CHECK (failure_retryable IS NULL OR failure_retryable IN (0, 1)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        revision INTEGER NOT NULL CHECK (revision >= 1), authentication_mode TEXT NOT NULL
        CHECK (authentication_mode IN ('system_agent', 'private_key')),
        PRIMARY KEY(owner_id, target_id, host_id),
        CHECK (
          (trust_algorithm IS NULL AND trust_fingerprint IS NULL AND trust_pinned_at IS NULL)
          OR (trust_algorithm IS NOT NULL AND trust_fingerprint IS NOT NULL AND trust_pinned_at IS NOT NULL)
        ),
        CHECK (
          (status = 'failed' AND failure_code IS NOT NULL AND failure_retryable IS NOT NULL)
          OR (status <> 'failed' AND failure_code IS NULL AND failure_retryable IS NULL)
        ),
        CHECK (
          failure_code IS NULL OR failure_retryable = CASE
            WHEN failure_code IN ('aborted', 'connection_failed', 'connection_timeout', 'connector_unavailable')
            THEN 1 ELSE 0 END
        ),
        CHECK (status_changed_at BETWEEN created_at AND updated_at),
        CHECK (trust_pinned_at IS NULL OR trust_pinned_at BETWEEN created_at AND updated_at)
      ) STRICT, WITHOUT ROWID;

CREATE TABLE review_attachments (
        review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 20),
        kind TEXT NOT NULL CHECK (kind IN ('file', 'image')),
        display_name TEXT NOT NULL CHECK (
          length(trim(display_name)) BETWEEN 1 AND 500
          AND instr(display_name, '/') = 0 AND instr(display_name, char(92)) = 0
        ),
        blob_id TEXT NOT NULL CHECK (length(trim(blob_id)) BETWEEN 1 AND 500 AND instr(blob_id, '/') = 0 AND instr(blob_id, char(92)) = 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 255),
        file_name TEXT CHECK (file_name IS NULL OR (
          length(trim(file_name)) BETWEEN 1 AND 500
          AND instr(file_name, '/') = 0 AND instr(file_name, char(92)) = 0
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(review_run_id, ordinal),
        UNIQUE(review_run_id, blob_id)
      ) STRICT;

CREATE TABLE review_evidence_snapshots (
        review_run_id TEXT PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
        seal_version INTEGER NOT NULL CHECK (seal_version = 1),
        conversation_sha256 TEXT NOT NULL CHECK (length(conversation_sha256) = 64 AND conversation_sha256 NOT GLOB '*[^0-9a-f]*'),
        workspace_sha256 TEXT NOT NULL CHECK (length(workspace_sha256) = 64 AND workspace_sha256 NOT GLOB '*[^0-9a-f]*'),
        files_sha256 TEXT NOT NULL CHECK (length(files_sha256) = 64 AND files_sha256 NOT GLOB '*[^0-9a-f]*'),
        artifacts_sha256 TEXT NOT NULL CHECK (length(artifacts_sha256) = 64 AND artifacts_sha256 NOT GLOB '*[^0-9a-f]*'),
        seal_sha256 TEXT NOT NULL CHECK (length(seal_sha256) = 64 AND seal_sha256 NOT GLOB '*[^0-9a-f]*'),
        created_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE review_runs (
        id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 500 AND instr(id, '/') = 0 AND instr(id, char(92)) = 0),
        source_session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE RESTRICT,
        reviewer_session_id TEXT UNIQUE REFERENCES product_sessions(id) ON DELETE RESTRICT,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('changes', 'artifacts', 'task', 'mixed')),
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
        freshness TEXT NOT NULL CHECK (freshness IN ('current', 'stale', 'unavailable')),
        freshness_checked_at INTEGER NOT NULL CHECK (freshness_checked_at >= 0),
        result_text TEXT,
        failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
          'no-visible-result', 'reviewer-closed', 'cancelled-before-start', 'interrupted',
          'source-workspace-changed', 'source-conversation-changed',
          'source-files-changed', 'artifact-changed', 'artifact-unavailable', 'provider-failed'
        )),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ended_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(id, source_session_id),
        UNIQUE(id, reviewer_session_id),
        CHECK (
          (state = 'running' AND result_text IS NULL AND failure_code IS NULL AND ended_at IS NULL)
          OR (state = 'completed' AND result_text IS NOT NULL AND length(trim(result_text)) BETWEEN 1 AND 100000 AND failure_code IS NULL AND ended_at IS NOT NULL)
          OR (state = 'failed' AND result_text IS NULL AND failure_code IS NOT NULL AND ended_at IS NOT NULL)
        )
      ) STRICT;

CREATE TABLE review_source_leases (
        review_run_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE RESTRICT,
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'released')),
        created_at INTEGER NOT NULL,
        released_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(source_session_id, fencing_token),
        FOREIGN KEY(review_run_id, source_session_id)
          REFERENCES review_runs(id, source_session_id) ON DELETE CASCADE,
        CHECK ((state = 'active' AND released_at IS NULL) OR (state = 'released' AND released_at IS NOT NULL))
      ) STRICT;

CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE RESTRICT,
        source TEXT NOT NULL CHECK (source IN ('user', 'schedule', 'system')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'retrying', 'completed', 'aborted', 'failed', 'dispatch_unknown')),
        parent_run_id TEXT REFERENCES runs(id),
        active_attempt_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        error_json TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE schedule_run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        session_id TEXT REFERENCES product_sessions(id) ON DELETE SET NULL,
        fired_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        detail_json TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(schedule_id, run_id),
        CHECK (finished_at IS NULL OR finished_at >= fired_at)
      ) STRICT;

CREATE TABLE schedule_runtime_occurrences (
        run_id TEXT PRIMARY KEY CHECK (
          length(trim(run_id)) BETWEEN 1 AND 256
          AND instr(run_id, char(0)) = 0
        ),
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('automatic', 'run-now')),
        execution_mode TEXT CHECK (execution_mode IS NULL OR execution_mode IN ('agent', 'script')),
        phase TEXT NOT NULL CHECK (phase IN (
          'loading', 'claiming', 'persisting', 'running', 'queued',
          'cancelling', 'finalizing', 'stalled', 'recovering'
        )),
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
        ),
        owner_generation INTEGER NOT NULL CHECK (owner_generation >= 1),
        scheduled_at INTEGER NOT NULL CHECK (scheduled_at >= 0),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= started_at),
        last_progress_at INTEGER NOT NULL CHECK (
          last_progress_at >= started_at AND last_progress_at <= heartbeat_at
        ),
        lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > heartbeat_at),
        stall_detected_at INTEGER CHECK (
          stall_detected_at IS NULL OR stall_detected_at >= last_progress_at
        ),
        abort_requested_at INTEGER CHECK (
          abort_requested_at IS NULL OR abort_requested_at >= last_progress_at
        ),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (phase = 'stalled' AND stall_detected_at IS NOT NULL AND abort_requested_at IS NOT NULL)
          OR phase <> 'stalled'
        )
      ) STRICT;

CREATE TABLE scheduler_runtime_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
        ),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= started_at),
        lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > heartbeat_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL REFERENCES backends(id) ON DELETE RESTRICT,
        target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
        session_id TEXT REFERENCES product_sessions(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('one_shot', 'cron', 'interval', 'manual')),
        expression TEXT,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        prompt_json TEXT NOT NULL,
        execution_snapshot_json TEXT NOT NULL,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        overlap_policy TEXT NOT NULL CHECK (overlap_policy IN ('queue', 'skip')),
        misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('run_once', 'skip')),
        anchor_at INTEGER,
        session_mode TEXT NOT NULL CHECK (session_mode IN ('fresh', 'persistent', 'bound'))
      ) STRICT;

CREATE TABLE session_attention (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('done', 'awaiting', 'error')),
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        subject_cursor INTEGER NOT NULL CHECK (subject_cursor >= 1),
        subject_generation INTEGER NOT NULL CHECK (subject_generation >= 0),
        attention_cursor INTEGER NOT NULL CHECK (attention_cursor >= 1),
        attention_generation INTEGER NOT NULL CHECK (attention_generation >= 0),
        read_through_cursor INTEGER NOT NULL CHECK (read_through_cursor >= 0),
        read_through_generation INTEGER NOT NULL CHECK (read_through_generation >= 0),
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (subject_cursor <= attention_cursor),
        CHECK (subject_generation <= attention_generation),
        CHECK (subject_cursor < attention_cursor OR subject_generation = attention_generation),
        CHECK (read_through_cursor <> 0 OR read_through_generation = 0),
        CHECK (read_through_generation <= attention_generation),
        CHECK (
          (unread = 1 AND read_through_cursor < attention_cursor)
          OR (
            unread = 0
            AND read_through_cursor = attention_cursor
            AND read_through_generation = attention_generation
          )
        )
      ) STRICT;

CREATE TABLE session_context_rebuilds (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        latest_deletion_operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
        source_native_opaque_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'running')),
        claim_token TEXT,
        claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        reason TEXT NOT NULL CHECK (reason IN ('message_deletion', 'context_overflow', 'prompt_timeout')),
        source_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        source_queue_item_id TEXT REFERENCES queue_items(id) ON DELETE RESTRICT,
        source_input_pending INTEGER NOT NULL CHECK (source_input_pending IN (0, 1)),
        replay_safe INTEGER NOT NULL CHECK (replay_safe IN (0, 1))
      ) STRICT;

CREATE TABLE session_event_counters (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0)
      ) STRICT;

CREATE TABLE session_objectives (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        objective_text TEXT NOT NULL CHECK (
          length(trim(objective_text)) BETWEEN 1 AND 32000
          AND instr(objective_text, char(0)) = 0
        ),
        status TEXT NOT NULL CHECK (status IN (
          'active', 'paused', 'blocked', 'complete', 'budget_limited',
          'usage_limited', 'dispatch_unknown'
        )),
        token_budget INTEGER CHECK (token_budget IS NULL OR token_budget BETWEEN 1 AND 9007199254740991),
        maximum_turns INTEGER CHECK (maximum_turns IS NULL OR maximum_turns BETWEEN 1 AND 10000),
        no_progress_turn_limit INTEGER CHECK (
          no_progress_turn_limit IS NULL OR no_progress_turn_limit BETWEEN 1 AND 1000
        ),
        turns_used INTEGER NOT NULL CHECK (turns_used BETWEEN 0 AND 10000),
        tokens_used INTEGER NOT NULL CHECK (tokens_used BETWEEN 0 AND 9007199254740991),
        no_progress_turns INTEGER NOT NULL CHECK (no_progress_turns BETWEEN 0 AND 1000),
        dispatch_rejections INTEGER NOT NULL CHECK (dispatch_rejections BETWEEN 0 AND 4),
        last_reason TEXT CHECK (
          last_reason IS NULL OR (
            length(last_reason) BETWEEN 1 AND 2048
            AND instr(last_reason, char(0)) = 0
          )
        ),
        owner_generation INTEGER NOT NULL CHECK (owner_generation BETWEEN 1 AND 9007199254740991),
        session_generation INTEGER NOT NULL CHECK (session_generation BETWEEN 0 AND 9007199254740991),
        pending_owner_generation INTEGER CHECK (
          pending_owner_generation IS NULL OR pending_owner_generation BETWEEN 1 AND 9007199254740991
        ),
        pending_operation_id TEXT REFERENCES operations(id) ON DELETE RESTRICT,
        pending_run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
        pending_attempt_id TEXT REFERENCES attempts(id) ON DELETE RESTRICT,
        pending_queue_item_id TEXT REFERENCES queue_items(id) ON DELETE RESTRICT,
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (pending_owner_generation IS NULL AND pending_operation_id IS NULL
            AND pending_run_id IS NULL AND pending_attempt_id IS NULL
            AND pending_queue_item_id IS NULL)
          OR
          (pending_owner_generation IS NOT NULL AND pending_operation_id IS NOT NULL
            AND pending_run_id IS NOT NULL AND pending_attempt_id IS NOT NULL
            AND pending_queue_item_id IS NOT NULL)
        )
      ) STRICT;

CREATE TABLE session_reset_boundaries (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        reset_operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
        cleared_through_event_cursor INTEGER NOT NULL CHECK (cleared_through_event_cursor >= 0),
        cleared_through_run_rowid INTEGER NOT NULL CHECK (cleared_through_run_rowid >= 0),
        cleared_through_queue_rowid INTEGER NOT NULL CHECK (cleared_through_queue_rowid >= 0),
        cleared_through_interaction_rowid INTEGER NOT NULL CHECK (cleared_through_interaction_rowid >= 0),
        cleared_through_artifact_rowid INTEGER NOT NULL CHECK (cleared_through_artifact_rowid >= 0),
        cleared_through_tool_lease_rowid INTEGER NOT NULL CHECK (cleared_through_tool_lease_rowid >= 0),
        generation INTEGER NOT NULL CHECK (generation >= 1),
        reset_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE session_runtime_policies (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
        review_run_id TEXT NOT NULL UNIQUE,
        policy TEXT NOT NULL CHECK (policy = 'review_read_only'),
        source_lease_fencing_token INTEGER NOT NULL CHECK (source_lease_fencing_token >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        FOREIGN KEY(review_run_id, session_id)
          REFERENCES review_runs(id, reviewer_session_id) ON DELETE CASCADE
      ) STRICT;

CREATE TABLE session_worktrees (
        session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE RESTRICT,
        lease_id TEXT NOT NULL UNIQUE CHECK (
          length(lease_id) BETWEEN 1 AND 256 AND instr(lease_id, char(0)) = 0
        ),
        workspace_id TEXT NOT NULL UNIQUE CHECK (
          length(workspace_id) BETWEEN 1 AND 256 AND instr(workspace_id, char(0)) = 0
        ),
        working_path TEXT NOT NULL CHECK (
          length(working_path) BETWEEN 1 AND 32768 AND instr(working_path, char(0)) = 0
        ),
        repository_root TEXT NOT NULL CHECK (
          length(repository_root) BETWEEN 1 AND 32768 AND instr(repository_root, char(0)) = 0
        ),
        branch TEXT NOT NULL CHECK (
          length(branch) BETWEEN 1 AND 1024 AND instr(branch, char(0)) = 0
        ),
        source_ref TEXT NOT NULL CHECK (
          length(source_ref) BETWEEN 1 AND 1024 AND instr(source_ref, char(0)) = 0
        ),
        source_commit TEXT NOT NULL CHECK (
          length(source_commit) BETWEEN 40 AND 64
          AND source_commit NOT GLOB '*[^a-f0-9]*'
        ),
        source_strategy TEXT NOT NULL CHECK (source_strategy IN (
          'explicit', 'remote_default_refreshed', 'remote_default_local',
          'current_branch', 'local_default', 'head'
        )),
        source_refreshed INTEGER NOT NULL CHECK (source_refreshed IN (0, 1)),
        source_remote TEXT CHECK (
          source_remote IS NULL OR (
            length(source_remote) BETWEEN 1 AND 128
            AND source_remote NOT GLOB '*[^A-Za-z0-9._-]*'
          )
        ),
        state TEXT NOT NULL CHECK (state IN ('active', 'preserved')),
        acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= acquired_at),
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE TABLE settings (
        scope_type TEXT NOT NULL CHECK (scope_type IN ('service', 'connection', 'backend', 'target', 'session')),
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(scope_type, scope_id, key)
      ) STRICT;

CREATE TABLE store_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      ) STRICT;

CREATE TABLE targets (
        id TEXT PRIMARY KEY,
        backend_id TEXT NOT NULL REFERENCES backends(id) ON DELETE RESTRICT,
        display_name TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        managed INTEGER NOT NULL CHECK (managed IN (0, 1)),
        trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      , remote_host_id TEXT CHECK (
        remote_host_id IS NULL OR (
          length(trim(remote_host_id)) BETWEEN 1 AND 256
          AND instr(remote_host_id, char(0)) = 0
          AND instr(remote_host_id, '*') = 0
          AND instr(remote_host_id, '?') = 0
          AND substr(remote_host_id, 1, 1) <> '!'
        )
      ), remote_workspace_root TEXT CHECK (
        remote_workspace_root IS NULL OR (
          length(remote_workspace_root) BETWEEN 1 AND 16384
          AND substr(remote_workspace_root, 1, 1) = '/'
          AND instr(remote_workspace_root, char(0)) = 0
        )
      )) STRICT;

CREATE TABLE tool_fence_counters (
        tool_id TEXT PRIMARY KEY,
        last_token INTEGER NOT NULL CHECK (last_token >= 0)
      ) STRICT;

CREATE TABLE tool_leases (
        id TEXT PRIMARY KEY,
        tool_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'released', 'revoked', 'expired')),
        expires_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        released_at INTEGER,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        UNIQUE(tool_id, fencing_token)
      ) STRICT;

CREATE TABLE usage_daily_ledger (
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
          AND instr(owner_id, char(10)) = 0
          AND instr(owner_id, char(13)) = 0
        ),
        session_id TEXT NOT NULL CHECK (
          length(trim(session_id)) BETWEEN 1 AND 256
          AND instr(session_id, char(0)) = 0
        ),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        backend_id TEXT NOT NULL CHECK (
          length(trim(backend_id)) BETWEEN 1 AND 256
          AND instr(backend_id, char(0)) = 0
        ),
        provider_id TEXT NOT NULL CHECK (
          length(provider_id) <= 512 AND instr(provider_id, char(0)) = 0
        ),
        model_id TEXT NOT NULL CHECK (
          length(model_id) <= 512 AND instr(model_id, char(0)) = 0
        ),
        day TEXT NOT NULL CHECK (length(day) = 10),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
        currency_code TEXT NOT NULL CHECK (
          length(currency_code) BETWEEN 3 AND 8
          AND currency_code = upper(currency_code)
        ),
        cost_complete INTEGER NOT NULL CHECK (cost_complete IN (0, 1)),
        estimated INTEGER NOT NULL CHECK (estimated IN (0, 1)),
        first_measured_at INTEGER NOT NULL CHECK (first_measured_at >= 0),
        last_measured_at INTEGER NOT NULL CHECK (last_measured_at >= first_measured_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, session_id, generation, backend_id, provider_id, model_id, day, currency_code)
      ) STRICT;

CREATE TABLE usage_session_cursors (
        owner_id TEXT NOT NULL CHECK (
          length(trim(owner_id)) BETWEEN 1 AND 256
          AND instr(owner_id, char(0)) = 0
          AND instr(owner_id, char(10)) = 0
          AND instr(owner_id, char(13)) = 0
        ),
        session_id TEXT NOT NULL CHECK (
          length(trim(session_id)) BETWEEN 1 AND 256
          AND instr(session_id, char(0)) = 0
        ),
        source_id TEXT NOT NULL CHECK (
          length(trim(source_id)) BETWEEN 1 AND 512
          AND instr(source_id, char(0)) = 0
          AND instr(source_id, char(10)) = 0
          AND instr(source_id, char(13)) = 0
        ),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        backend_id TEXT NOT NULL CHECK (
          length(trim(backend_id)) BETWEEN 1 AND 256
          AND instr(backend_id, char(0)) = 0
        ),
        provider_id TEXT NOT NULL CHECK (
          length(provider_id) <= 512 AND instr(provider_id, char(0)) = 0
        ),
        model_id TEXT NOT NULL CHECK (
          length(model_id) <= 512 AND instr(model_id, char(0)) = 0
        ),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        reported_cost_micros INTEGER CHECK (
          reported_cost_micros IS NULL OR reported_cost_micros >= 0
        ),
        measured_at INTEGER NOT NULL CHECK (measured_at >= 0),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY(owner_id, session_id, source_id)
      ) STRICT;

CREATE TABLE schedule_deletion_cleanups (
        operation_id TEXT PRIMARY KEY CHECK (
          length(trim(operation_id)) BETWEEN 1 AND 256
          AND instr(operation_id, char(0)) = 0
        ),
        schedule_id TEXT NOT NULL CHECK (
          length(trim(schedule_id)) BETWEEN 1 AND 256
          AND instr(schedule_id, char(0)) = 0
        ),
        disposition TEXT NOT NULL CHECK (disposition IN ('keep', 'archive', 'delete')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        generated_session_ids_json TEXT NOT NULL,
        occurrence_run_ids_json TEXT NOT NULL,
        inflight_count INTEGER NOT NULL CHECK (inflight_count >= 0),
        completed_session_ids_json TEXT NOT NULL,
        failures_json TEXT NOT NULL,
        project_target_id TEXT,
        project_config_id TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        CHECK (
          (project_target_id IS NULL AND project_config_id IS NULL)
          OR (project_target_id IS NOT NULL AND project_config_id IS NOT NULL)
        )
      ) STRICT;

CREATE TABLE session_lifecycle_cleanups (
        operation_id TEXT PRIMARY KEY CHECK (
          length(trim(operation_id)) BETWEEN 1 AND 256
          AND instr(operation_id, char(0)) = 0
        ),
        session_id TEXT NOT NULL CHECK (
          length(trim(session_id)) BETWEEN 1 AND 256
          AND instr(session_id, char(0)) = 0
        ),
        disposition TEXT NOT NULL CHECK (disposition IN ('archive', 'delete')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        delete_native INTEGER NOT NULL CHECK (delete_native IN (0, 1)),
        delete_artifacts INTEGER NOT NULL CHECK (delete_artifacts IN (0, 1)),
        release_worktree INTEGER NOT NULL CHECK (release_worktree IN (0, 1)),
        cleanup_git_safety INTEGER NOT NULL CHECK (cleanup_git_safety IN (0, 1)),
        close_completed INTEGER NOT NULL CHECK (close_completed IN (0, 1)),
        native_completed INTEGER NOT NULL CHECK (native_completed IN (0, 1)),
        worktree_completed INTEGER NOT NULL CHECK (worktree_completed IN (0, 1)),
        git_safety_completed INTEGER NOT NULL CHECK (git_safety_completed IN (0, 1)),
        failure_json TEXT,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        revision INTEGER NOT NULL CHECK (revision >= 1)
      ) STRICT;

CREATE UNIQUE INDEX session_lifecycle_cleanups_pending_session_idx
        ON session_lifecycle_cleanups(session_id) WHERE state = 'pending';

CREATE INDEX artifacts_session_idx
        ON artifacts(session_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE INDEX artifacts_storage_key_idx ON artifacts(storage_key);

CREATE INDEX attempts_run_idx ON attempts(run_id, ordinal);

CREATE INDEX connections_device_idx ON connections(device_id, paired_at, id);

CREATE INDEX device_control_relations_target_idx
        ON device_control_relations(target_device_id, controller_device_id);

CREATE INDEX diagnostics_component_idx ON diagnostics(component, created_at DESC);

CREATE INDEX diagnostics_time_idx ON diagnostics(created_at DESC);

CREATE INDEX events_revision_idx ON events(revision, global_cursor);

CREATE INDEX events_run_idx ON events(run_id, global_cursor) WHERE run_id IS NOT NULL;

CREATE INDEX events_session_cursor_idx ON events(session_id, global_cursor);

CREATE INDEX events_session_sequence_idx ON events(session_id, session_sequence);

CREATE INDEX interactions_open_idx ON interactions(session_id, created_at) WHERE status = 'open';

CREATE INDEX local_model_pull_checkpoints_owner_idx
        ON local_model_pull_checkpoints(owner_id, runtime_id, owner_generation, updated_at DESC);

CREATE INDEX local_runtime_installations_lease_idx
        ON local_runtime_installations(state, lease_expires_at)
        WHERE state = 'installing';

CREATE INDEX maker_memory_backend_idx
        ON maker_memory_entries(backend_id, kind, updated_at DESC, id)
        WHERE backend_id IS NOT NULL;

CREATE INDEX maker_memory_target_idx
        ON maker_memory_entries(target_id, kind, updated_at DESC, id);

CREATE INDEX message_embedding_jobs_dispatch_idx
        ON message_embedding_jobs(status, scheduled_at, event_cursor);

CREATE INDEX message_embedding_records_generation_idx
        ON message_embedding_records(
          provider_id, provider_generation_id, model_id, dimensions, event_cursor
        );

CREATE INDEX message_embedding_records_model_idx
        ON message_embedding_records(model_id, event_cursor);

CREATE INDEX message_event_tombstones_session_idx
        ON message_event_tombstones(session_id, deleted_at, event_id);

CREATE INDEX model_price_overrides_owner_idx
        ON model_price_overrides(owner_id, updated_at DESC, backend_id, provider_id, model_id);

CREATE INDEX operations_connection_idx ON operations(connection_id, created_at DESC);

CREATE INDEX operations_pending_effect_idx
        ON operations(status, completion_mode, created_at, id)
        WHERE status = 'started' AND completion_mode = 'external_effect';

CREATE INDEX pairings_expiry_idx ON pairings(expires_at) WHERE consumed_at IS NULL;

CREATE INDEX queue_dispatch_idx ON queue_items(state, created_at, id);

CREATE UNIQUE INDEX queue_operation_idx ON queue_items(operation_id);

CREATE INDEX queue_session_idx ON queue_items(session_id, created_at, id);

CREATE INDEX queue_session_position_idx ON queue_items(session_id, position, created_at, id);

CREATE INDEX remote_hosts_credential_reference_idx
        ON remote_hosts(owner_id, credential_reference_id)
        WHERE credential_reference_id IS NOT NULL;

CREATE INDEX remote_hosts_owner_target_idx
        ON remote_hosts(owner_id, target_id, updated_at DESC, host_id);

CREATE INDEX review_runs_reviewer_idx ON review_runs(reviewer_session_id, created_at DESC, id)
        WHERE reviewer_session_id IS NOT NULL;

CREATE INDEX review_runs_running_idx ON review_runs(created_at, id) WHERE state = 'running';

CREATE INDEX review_runs_source_idx ON review_runs(source_session_id, created_at DESC, id);

CREATE UNIQUE INDEX review_source_leases_active_source_idx
        ON review_source_leases(source_session_id) WHERE state = 'active';

CREATE INDEX runs_active_idx ON runs(state, created_at) WHERE state IN ('queued', 'running', 'waiting', 'retrying', 'dispatch_unknown');

CREATE UNIQUE INDEX runs_parent_once_idx ON runs(parent_run_id) WHERE parent_run_id IS NOT NULL;

CREATE INDEX runs_session_idx ON runs(session_id, created_at DESC);

CREATE INDEX schedule_history_idx
        ON schedule_run_history(schedule_id, fired_at DESC);

CREATE UNIQUE INDEX schedule_history_run_idx
        ON schedule_run_history(run_id);

CREATE INDEX schedule_history_session_idx
        ON schedule_run_history(session_id, fired_at DESC)
        WHERE session_id IS NOT NULL;

CREATE INDEX schedule_runtime_occurrences_schedule_idx
        ON schedule_runtime_occurrences(schedule_id, started_at, run_id);

CREATE INDEX schedule_runtime_occurrences_stale_idx
        ON schedule_runtime_occurrences(lease_expires_at, run_id);

CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at) WHERE enabled = 1;

CREATE INDEX session_attention_unread_idx
        ON session_attention(unread, kind, updated_at DESC) WHERE unread = 1;

CREATE INDEX session_context_rebuilds_dispatch_idx
        ON session_context_rebuilds(state, updated_at, session_id);

CREATE INDEX session_context_rebuilds_source_run_idx
        ON session_context_rebuilds(source_run_id)
        WHERE source_run_id IS NOT NULL;

CREATE UNIQUE INDEX session_objectives_pending_queue_idx
        ON session_objectives(pending_queue_item_id) WHERE pending_queue_item_id IS NOT NULL;

CREATE UNIQUE INDEX session_objectives_pending_run_idx
        ON session_objectives(pending_run_id) WHERE pending_run_id IS NOT NULL;

CREATE INDEX session_objectives_status_idx
        ON session_objectives(status, updated_at, session_id);

CREATE INDEX session_worktrees_state_idx
        ON session_worktrees(state, updated_at DESC, session_id);

CREATE UNIQUE INDEX sessions_live_native_binding_idx
        ON product_sessions(backend_id, native_opaque_ref COLLATE NOCASE)
        WHERE deleted_at IS NULL;

CREATE INDEX sessions_navigation_idx ON product_sessions(archived, pinned DESC, updated_at DESC)
        WHERE deleted_at IS NULL;

CREATE INDEX sessions_pinned_summary_idx
        ON product_sessions(pinned, archived, summary_updated_at, updated_at DESC)
        WHERE deleted_at IS NULL AND pinned = 1;

CREATE INDEX sessions_project_idx
        ON product_sessions(project_id, updated_at DESC)
        WHERE deleted_at IS NULL;

CREATE INDEX sessions_remote_host_idx
        ON product_sessions(target_id, remote_host_id, updated_at DESC)
        WHERE remote_host_id IS NOT NULL;

CREATE INDEX sessions_target_idx ON product_sessions(target_id, updated_at DESC);

CREATE INDEX native_history_identity_lookup_idx
        ON native_history_event_identities(session_id, binding_fingerprint, entry_id, event_cursor);

CREATE INDEX native_history_marker_cursor_idx
        ON native_history_current_markers(event_cursor);

CREATE INDEX targets_backend_idx ON targets(backend_id);

CREATE INDEX targets_remote_host_idx ON targets(remote_host_id)
        WHERE remote_host_id IS NOT NULL;

CREATE INDEX tool_leases_active_idx ON tool_leases(tool_id, expires_at) WHERE state = 'active';

CREATE INDEX usage_daily_owner_day_idx
        ON usage_daily_ledger(owner_id, day, provider_id, model_id);

CREATE INDEX usage_daily_provider_idx
        ON usage_daily_ledger(owner_id, provider_id, day, model_id);

CREATE INDEX usage_session_cursors_provider_idx
        ON usage_session_cursors(owner_id, provider_id, measured_at DESC);

CREATE TRIGGER enqueue_visible_message_embedding
      AFTER INSERT ON events
      WHEN (
          (
            json_extract(NEW.payload_json, '$.payload.type') = 'message_complete'
            AND json_extract(NEW.payload_json, '$.payload.role') IN ('user', 'assistant')
            AND json_extract(NEW.payload_json, '$.payload.automaticContinuation') IS NULL
          )
          OR (
            json_extract(NEW.payload_json, '$.payload.type') = 'interaction_opened'
            AND json_extract(NEW.payload_json, '$.payload.interaction.kind') IN ('question', 'plan_review')
          )
        )
        AND (SELECT enabled FROM message_embedding_state WHERE singleton = 1) = 1
      BEGIN
        INSERT OR IGNORE INTO message_embedding_jobs(
          event_cursor, status, attempts, scheduled_at, claimed_at, error_code
        ) VALUES (NEW.global_cursor, 'pending', 0, NEW.emitted_at, NULL, NULL);
      END;

CREATE TRIGGER local_model_pull_checkpoints_owner_insert
      BEFORE INSERT ON local_model_pull_checkpoints
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local model pull owner generation is stale');
      END;

CREATE TRIGGER local_model_pull_checkpoints_owner_update
      BEFORE UPDATE ON local_model_pull_checkpoints
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local model pull owner generation is stale');
      END;

CREATE TRIGGER local_runtime_installations_owner_insert
      BEFORE INSERT ON local_runtime_installations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local runtime installation owner generation is stale');
      END;

CREATE TRIGGER local_runtime_installations_owner_update
      BEFORE UPDATE ON local_runtime_installations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local runtime installation owner generation is stale');
      END;

CREATE TRIGGER local_runtime_provider_bindings_owner_insert
      BEFORE INSERT ON local_runtime_provider_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local runtime Provider owner generation is stale');
      END;

CREATE TRIGGER local_runtime_provider_bindings_owner_update
      BEFORE UPDATE ON local_runtime_provider_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM local_runtime_owners owner
        WHERE owner.owner_id = NEW.owner_id
          AND owner.runtime_id = NEW.runtime_id
          AND owner.generation = NEW.owner_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'local runtime Provider owner generation is stale');
      END;

CREATE TRIGGER remote_hosts_auth_insert
      BEFORE INSERT ON remote_hosts
      WHEN NOT (
        (NEW.authentication_mode = 'system_agent' AND NEW.credential_reference_id IS NULL)
        OR (NEW.authentication_mode = 'private_key' AND NEW.credential_reference_id IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'remote host authentication metadata is inconsistent');
      END;

CREATE TRIGGER remote_hosts_auth_update
      BEFORE UPDATE OF authentication_mode, credential_reference_id ON remote_hosts
      WHEN NOT (
        (NEW.authentication_mode = 'system_agent' AND NEW.credential_reference_id IS NULL)
        OR (NEW.authentication_mode = 'private_key' AND NEW.credential_reference_id IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'remote host authentication metadata is inconsistent');
      END;

CREATE TRIGGER remote_hosts_protect_active_delete
      BEFORE DELETE ON remote_hosts
      WHEN OLD.status IN ('connecting', 'authenticating', 'ready')
      BEGIN
        SELECT RAISE(ABORT, 'active remote host cannot be deleted');
      END;

CREATE TRIGGER remote_hosts_protect_bound_delete
      BEFORE DELETE ON remote_hosts
      WHEN EXISTS (
        SELECT 1 FROM targets
        WHERE id = OLD.target_id AND remote_host_id = OLD.host_id
      ) OR EXISTS (
        SELECT 1 FROM product_sessions
        WHERE target_id = OLD.target_id AND remote_host_id = OLD.host_id AND deleted_at IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'bound remote host cannot be deleted');
      END;

CREATE TRIGGER session_objectives_follow_session_generation
      AFTER UPDATE OF generation ON product_sessions
      WHEN OLD.generation <> NEW.generation
      BEGIN
        UPDATE session_objectives
        SET session_generation = NEW.generation,
            updated_at = MAX(updated_at, NEW.updated_at),
            revision = NEW.revision
        WHERE session_id = NEW.id;
      END;

CREATE TRIGGER session_objectives_generation_insert
      BEFORE INSERT ON session_objectives
      WHEN NOT EXISTS (
        SELECT 1 FROM product_sessions session
        WHERE session.id = NEW.session_id
          AND session.generation = NEW.session_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'objective session generation is stale');
      END;

CREATE TRIGGER session_objectives_generation_update
      BEFORE UPDATE ON session_objectives
      WHEN NOT EXISTS (
        SELECT 1 FROM product_sessions session
        WHERE session.id = NEW.session_id
          AND session.generation = NEW.session_generation
      )
      BEGIN
        SELECT RAISE(ABORT, 'objective session generation is stale');
      END;

CREATE TRIGGER sessions_remote_binding_insert
      BEFORE INSERT ON product_sessions
      WHEN (NEW.remote_host_id IS NULL) <> (NEW.remote_workspace_root IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'session remote workspace binding is incomplete');
      END;

CREATE TRIGGER sessions_remote_binding_update
      BEFORE UPDATE OF remote_host_id, remote_workspace_root ON product_sessions
      WHEN (NEW.remote_host_id IS NULL) <> (NEW.remote_workspace_root IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'session remote workspace binding is incomplete');
      END;

CREATE TRIGGER targets_remote_binding_insert
      BEFORE INSERT ON targets
      WHEN (NEW.remote_host_id IS NULL) <> (NEW.remote_workspace_root IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'target remote workspace binding is incomplete');
      END;

CREATE TRIGGER targets_remote_binding_update
      BEFORE UPDATE OF remote_host_id, remote_workspace_root ON targets
      WHEN (NEW.remote_host_id IS NULL) <> (NEW.remote_workspace_root IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'target remote workspace binding is incomplete');
      END;

INSERT INTO store_meta(singleton, revision) VALUES (1, 0);
INSERT INTO message_embedding_state(singleton, enabled, cutoff_cursor, model_id, dimensions, provider_id, cutoff_initialized, provider_generation_id) VALUES (1, 0, 0, 'voyage/voyage-4', 1024, NULL, 0, NULL);
`;

/** Exact first-release schema identity, including its marker table. */
export const SCHEMA_BASELINE_ID = createHash("sha256")
  .update(`schema-version:${SCHEMA_VERSION}\n${SCHEMA_MARKER_SCHEMA}\n${BASELINE_SCHEMA}`)
  .digest("hex");

let expectedSchemaCatalogId: string | undefined;

// sqlite-vec 0.1.9 materializes this exact, derived object family for the
// optional message-search index. The objects contain no product authority and
// may be rebuilt, but the exemption must stay name-exact: an arbitrary object
// that merely borrows the prefix is schema drift, not a derived index.
const OPTIONAL_MESSAGE_VECTOR_SCHEMA_OBJECTS = new Set([
  "message_search_vectors",
  "message_search_vectors_chunks",
  "message_search_vectors_info",
  "message_search_vectors_metadatachunks00",
  "message_search_vectors_metadatachunks01",
  "message_search_vectors_metadatachunks02",
  "message_search_vectors_metadatachunks03",
  "message_search_vectors_metadatachunks04",
  "message_search_vectors_metadatachunks05",
  "message_search_vectors_metadatachunks06",
  "message_search_vectors_metadatatext01",
  "message_search_vectors_metadatatext02",
  "message_search_vectors_metadatatext03",
  "message_search_vectors_metadatatext04",
  "message_search_vectors_metadatatext05",
  "message_search_vectors_rowids",
  "message_search_vectors_vector_chunks00"
]);

function schemaCatalogId(database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all() as Array<Record<string, unknown>>;
  const authoritativeRows = rows.filter((row) =>
    !OPTIONAL_MESSAGE_VECTOR_SCHEMA_OBJECTS.has(String(row["name"] ?? ""))
  );
  return createHash("sha256").update(JSON.stringify(authoritativeRows)).digest("hex");
}

function requiredSchemaCatalogId(): string {
  if (expectedSchemaCatalogId !== undefined) return expectedSchemaCatalogId;
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(`${SCHEMA_MARKER_SCHEMA}\n${BASELINE_SCHEMA}`);
    expectedSchemaCatalogId = schemaCatalogId(expected);
    return expectedSchemaCatalogId;
  } finally {
    expected.close();
  }
}

function assertExactSchemaCatalog(database: DatabaseSync): void {
  if (schemaCatalogId(database) !== requiredSchemaCatalogId()) {
    throw new Error("The operational store schema is unsupported; create a new database.");
  }
}

export function configureDatabase(database: DatabaseSync): void {
  // WAL permits concurrent readers and serialized writers by default, but the
  // product requires exactly one active Orchestrator owner. SQLite's exclusive
  // locking mode is an OS-backed process lease: it is released automatically
  // on close/crash and cannot leave a stale sidecar lock behind.
  database.exec("PRAGMA locking_mode = EXCLUSIVE");
  const locking = database.prepare("PRAGMA locking_mode").get() as Record<string, unknown> | undefined;
  const lockingMode = String(locking?.["locking_mode"] ?? "unknown").toLowerCase();
  if (lockingMode !== "exclusive") {
    throw new ActiveWriterError({ cause: new Error(`locking_mode is ${lockingMode}`) });
  }
  try {
    // Touch a real database page before installing a busy timeout so a second
    // process fails immediately at startup instead of entering service with a
    // delayed write conflict.
    database.prepare("SELECT count(*) AS object_count FROM sqlite_schema").get();
  } catch (error) {
    if (isSqliteLockError(error)) throw new ActiveWriterError({ cause: error });
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA journal_mode = WAL");
  const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown> | undefined;
  const journalMode = String(journal?.["journal_mode"] ?? "unknown").toLowerCase();
  if (journalMode !== "wal" && journalMode !== "memory") {
    throw new Error(`SQLite WAL mode is required; journal_mode is ${journalMode}.`);
  }
}

function isSqliteLockError(error: unknown): boolean {
  return error instanceof Error && /\b(?:database|schema) is locked\b/i.test(error.message);
}

export function initializeDatabase(database: DatabaseSync, now = Date.now()): void {
  const marker = database.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'schema_version'
  `).get();
  if (marker !== undefined) {
    const markerColumns = database.prepare("PRAGMA table_info(schema_version)").all() as Array<Record<string, unknown>>;
    if (!markerColumns.some((column) => column["name"] === "baseline_id")) {
      throw new Error("The operational store schema is unsupported; create a new database.");
    }
    const row = database.prepare(
      "SELECT version, baseline_id FROM schema_version WHERE singleton = 1"
    ).get() as Record<string, unknown> | undefined;
    const pragma = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const storedVersion = Number(row?.["version"] ?? -1);
    const userVersion = Number(pragma?.["user_version"] ?? -1);
    if (
      storedVersion !== SCHEMA_VERSION ||
      userVersion !== SCHEMA_VERSION ||
      row?.["baseline_id"] !== SCHEMA_BASELINE_ID
    ) {
      throw new Error("The operational store schema is unsupported; create a new database.");
    }
    assertExactSchemaCatalog(database);
    return;
  }

  const existingObjects = database.prepare(`
    SELECT count(*) AS object_count
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
  `).get() as Record<string, unknown> | undefined;
  if (Number(existingObjects?.["object_count"] ?? 0) !== 0) {
    throw new Error("The operational store schema is unsupported; create a new database.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ${SCHEMA_MARKER_SCHEMA}
      ${BASELINE_SCHEMA}
    `);
    database.prepare(
      "INSERT INTO schema_version(singleton, version, baseline_id, initialized_at) VALUES (1, ?, ?, ?)"
    ).run(SCHEMA_VERSION, SCHEMA_BASELINE_ID, now);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    assertExactSchemaCatalog(database);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
