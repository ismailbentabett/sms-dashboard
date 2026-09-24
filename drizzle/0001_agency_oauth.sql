CREATE TABLE "ghl_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text,
	"user_id" text,
	"approved_locations" text[],
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locations_discovered_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "ghl_location_tokens" (
	"ghl_location_id" text PRIMARY KEY NOT NULL,
	"access_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "active_set_manually" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "installed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "discovered_at" timestamp with time zone DEFAULT now();