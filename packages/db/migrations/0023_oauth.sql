-- OAuth 2.1 for hosted MCP clients (ADR 0038). Four tables for the paperwork of
-- a connection; the access token it ends in is an ordinary agent credential.

CREATE TABLE "oauth_clients" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	-- The identifier the client sends. Ours is the id column; this is the protocol's.
	"client_id" varchar(64) NOT NULL,
	-- Null for a public client, which is what every hosted connector is.
	"client_secret_hash" varchar(128),
	-- The client's own `client_name`: supplied by whoever registered, shown to a
	-- person on the consent screen, and trusted by nothing.
	"name" varchar(200) NOT NULL,
	-- Matched exactly, as whole strings. No wildcards, no prefixes.
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" varchar(32) DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	-- Null while nobody has consented, which is how the expiry job finds them.
	"last_used_at" timestamp with time zone,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_clients_auth_method_check" CHECK ("token_endpoint_auth_method" IN ('none', 'client_secret_basic', 'client_secret_post'))
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"client_id" varchar(40) NOT NULL,
	"user_id" varchar(40) NOT NULL,
	"workspace_id" varchar(40) NOT NULL,
	-- The agent this client acts as, created by the consent that made this row.
	"agent_id" varchar(40) NOT NULL,
	-- The canonical URI the tokens are good for, and nothing else.
	"resource" text NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"grant_id" varchar(40) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"code_challenge_method" varchar(8) NOT NULL,
	"resource" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- Set when the code is spent. A code presented twice is a replay.
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_authorization_codes_code_hash_unique" UNIQUE("code_hash"),
	-- OAuth 2.1 requires PKCE and `plain` defeats the point of it.
	CONSTRAINT "oauth_authorization_codes_method_check" CHECK ("code_challenge_method" IN ('S256'))
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"grant_id" varchar(40) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	-- When it was exchanged. A token with this set is spent, not valid.
	"used_at" timestamp with time zone,
	"replaced_by_id" varchar(40),
	"revoked_at" timestamp with time zone,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
-- The consent that issued a token, when it came through OAuth. Null for one
-- somebody was shown once and pasted into a configuration file.
ALTER TABLE "agent_credentials" ADD COLUMN "oauth_grant_id" varchar(40);--> statement-breakpoint
-- No cascade from the client: the job that clears away registrations deletes
-- only the ones nobody consented to, and this is what makes that true rather
-- than intended.
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A code and a refresh token are nothing without the grant, so they go with it.
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_oauth_grant_id_oauth_grants_id_fk" FOREIGN KEY ("oauth_grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_clients_created_idx" ON "oauth_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_user_idx" ON "oauth_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_grants_agent_idx" ON "oauth_grants" USING btree ("agent_id");--> statement-breakpoint
-- Consenting again to the same client, person and workspace resumes the grant
-- that is already there, so a person who reconnects three times is one actor in
-- the ledger and not three.
CREATE UNIQUE INDEX "oauth_grants_live_idx" ON "oauth_grants" USING btree ("client_id","user_id","workspace_id") WHERE "oauth_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_expires_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_grant_idx" ON "oauth_refresh_tokens" USING btree ("grant_id");--> statement-breakpoint
-- One token replaces at most one predecessor: a rotation chain, not a tree.
CREATE UNIQUE INDEX "oauth_refresh_tokens_replaced_idx" ON "oauth_refresh_tokens" USING btree ("replaced_by_id");--> statement-breakpoint
CREATE INDEX "agent_credentials_grant_idx" ON "agent_credentials" USING btree ("oauth_grant_id");
