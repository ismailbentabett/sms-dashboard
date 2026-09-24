CREATE TABLE "contacts" (
	"ghl_contact_id" text PRIMARY KEY NOT NULL,
	"location_key" text NOT NULL,
	"company_name" text,
	"first_name" text,
	"last_name" text,
	"city" text,
	"state" text,
	"timezone" text,
	"phone_last4" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"dnd" boolean DEFAULT false NOT NULL,
	"dnd_message" text,
	"niche" text,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"loom_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"ghl_conversation_id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"location_key" text NOT NULL,
	"last_message_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ghl_location_id" text NOT NULL,
	"pipeline_id" text,
	"timezone_default" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_ghl_location_id_unique" UNIQUE("ghl_location_id")
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"location_key" text NOT NULL,
	"category" text NOT NULL,
	"path" text,
	"sequence" text,
	"step" integer,
	"label" text NOT NULL,
	"template_text" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"ghl_message_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"location_key" text NOT NULL,
	"direction" text NOT NULL,
	"message_type" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text,
	"error_code" text,
	"error_message" text,
	"sent_at" timestamp with time zone NOT NULL,
	"ghl_updated_at" timestamp with time zone,
	"source" text,
	"user_id" text,
	"template_id" integer,
	"match_method" text,
	"match_score" real,
	"attributed_template_id" integer,
	"attributed_message_id" text,
	"classification" text,
	"classification_source" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"ghl_opportunity_id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"location_key" text NOT NULL,
	"pipeline_id" text,
	"stage_id" text,
	"name" text,
	"status" text,
	"monetary_value" numeric,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"stage_changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"opportunity_id" text NOT NULL,
	"location_key" text NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_overrides" (
	"id" serial PRIMARY KEY NOT NULL,
	"location_key" text DEFAULT '*' NOT NULL,
	"normalized_name" text NOT NULL,
	"canonical_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"ghl_stage_id" text PRIMARY KEY NOT NULL,
	"location_key" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"position" integer NOT NULL,
	"canonical_name" text
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"location_key" text PRIMARY KEY NOT NULL,
	"messages_updated_at" timestamp with time zone,
	"contacts_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_deep_sync_at" timestamp with time zone,
	"backfill_from" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_locks" (
	"location_key" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"locked_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"location_key" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"rate_limit_hits" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_id" text,
	"event_type" text,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_location_key_locations_key_fk" FOREIGN KEY ("location_key") REFERENCES "public"."locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_location_key_locations_key_fk" FOREIGN KEY ("location_key") REFERENCES "public"."locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_location_key_locations_key_fk" FOREIGN KEY ("location_key") REFERENCES "public"."locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_message_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attributed_template_id_message_templates_id_fk" FOREIGN KEY ("attributed_template_id") REFERENCES "public"."message_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_location_key_locations_key_fk" FOREIGN KEY ("location_key") REFERENCES "public"."locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_location_key_locations_key_fk" FOREIGN KEY ("location_key") REFERENCES "public"."locations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_location_idx" ON "contacts" USING btree ("location_key");--> statement-breakpoint
CREATE INDEX "contacts_niche_idx" ON "contacts" USING btree ("niche");--> statement-breakpoint
CREATE INDEX "contacts_updated_idx" ON "contacts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_location_last_idx" ON "conversations" USING btree ("location_key","last_message_at");--> statement-breakpoint
CREATE INDEX "templates_location_category_idx" ON "message_templates" USING btree ("location_key","category");--> statement-breakpoint
CREATE INDEX "messages_location_sent_idx" ON "messages" USING btree ("location_key","sent_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_sent_idx" ON "messages" USING btree ("conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_contact_idx" ON "messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "messages_template_idx" ON "messages" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "messages_attributed_template_idx" ON "messages" USING btree ("attributed_template_id");--> statement-breakpoint
CREATE INDEX "messages_classification_idx" ON "messages" USING btree ("classification");--> statement-breakpoint
CREATE INDEX "messages_direction_idx" ON "messages" USING btree ("direction");--> statement-breakpoint
CREATE INDEX "opportunities_location_idx" ON "opportunities" USING btree ("location_key");--> statement-breakpoint
CREATE INDEX "opportunities_stage_idx" ON "opportunities" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "opportunities_contact_idx" ON "opportunities" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_history_uq" ON "stage_history" USING btree ("opportunity_id","to_stage","changed_at");--> statement-breakpoint
CREATE INDEX "stage_history_opp_idx" ON "stage_history" USING btree ("opportunity_id","changed_at");--> statement-breakpoint
CREATE INDEX "stage_history_to_stage_idx" ON "stage_history" USING btree ("to_stage");--> statement-breakpoint
CREATE UNIQUE INDEX "stage_overrides_uq" ON "stage_overrides" USING btree ("location_key","normalized_name");--> statement-breakpoint
CREATE INDEX "stages_location_idx" ON "stages" USING btree ("location_key");--> statement-breakpoint
CREATE INDEX "stages_canonical_idx" ON "stages" USING btree ("canonical_name");--> statement-breakpoint
CREATE INDEX "sync_runs_location_started_idx" ON "sync_runs" USING btree ("location_key","started_at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_idx" ON "webhook_events" USING btree ("received_at");