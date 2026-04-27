export {
  type Proposal,
  type ProposalType,
  type ProposalStatus,
  type BlastRadius,
  type Signal,
  type SignalSource,
  type SignalSeverity,
  type EvidencePointer,
  type SaveProposalInput,
  type UpdateProposalInput,
  PROPOSALS_DIR,
  ensureImprovementsDirs,
  saveProposal,
  getProposal,
  updateProposal,
  deleteProposal,
  listProposals,
  findProposalBySignalHash,
  parseProposal,
  serializeProposal,
} from "./store.js";

export {
  type ScanOptions,
  scanDaemonLog,
  signalHash,
  sinceHoursAgo,
} from "./scan.js";

export {
  type CriticalityRule,
  scoreProposal,
  isCritical,
} from "./rank.js";

export {
  type ProposeOptions,
  type ProposeResult,
  proposeFromSignals,
  rerankAll,
} from "./propose.js";

export {
  type RunRecord,
  RUNS_LOG_PATH,
  appendRun,
} from "./runs.js";
