-- Every other address shown anywhere in the bot (contract, wallet, sniper target) already renders
-- tap-to-copy (<code>/backtick). The Activity feed's "Sent X to <address>" entry was the one
-- exception: the recipient address was baked straight into the free-text `title` column, which
-- both bot layers HTML/markdown-escape wholesale before display -- there was no way for the
-- renderer to wrap just the address without also breaking the escaping that protects the rest of
-- the line. Splitting the address into its own column lets the renderer escape the title and wrap
-- the address separately.
ALTER TABLE activity ADD COLUMN IF NOT EXISTS address TEXT;
