-- Rename agent terminal status from "killed" to "archived". Sessions persist
-- in perpetuity; archiving an agent stops it from receiving work and (for
-- builders) frees its worktree, but doesn't delete chat history.
UPDATE agents SET status = 'archived' WHERE status = 'killed';
