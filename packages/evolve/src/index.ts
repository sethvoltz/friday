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
  type FeedbackScanOptions,
  type UsageScanOptions,
  scanDaemonLog,
  scanFeedback,
  scanUsageLog,
  scanTranscripts,
  signalHash,
  sinceHoursAgo,
} from "./scan.js";

export {
  type Cluster,
  type MergeOptions,
  type MergeResult,
  CLUSTERS_DIR,
  ensureClustersDir,
  listClusters,
  getCluster,
  saveCluster,
  parseCluster,
  serializeCluster,
  mergeClusters,
} from "./clusters.js";

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

export {
  type ApplyOutcome,
  type ApplyOptions,
  applyProposal,
  rejectProposal,
} from "./apply.js";

export {
  type DispatchResult,
  type DispatchOptions,
  dispatchCodeProposal,
} from "./dispatch.js";
