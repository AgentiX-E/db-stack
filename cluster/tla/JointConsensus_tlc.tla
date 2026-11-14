---- MODULE JointConsensus ----
EXTENDS Integers, FiniteSets, TLC

CONSTANT
  Nodes,
  MaxTerm,
  LogSize,
  StrOrConfig

VARIABLES
  serverState,
  currentTerm,
  votedFor,
  log,
  commitIndex,
  lastApplied,
  nextIndex,
  matchIndex,
  config,
  transitional,
  leaderNode

\* ---- Types ----

LogEntry == [type: {"normal", "config"}, term: Term,
             data: StrOrConfig, oldConfig: Config, newConfig: Config]

Config == SUBSET Nodes

Term == 1..MaxTerm

Majority(S) == Cardinality(S) \div 2 + 1

None == -1

\* ---- Init ----

Init ==
  /\ serverState = [n \in Nodes |-> "follower"]
  /\ currentTerm = [n \in Nodes |-> 1]
  /\ votedFor = [n \in Nodes |-> None]
  /\ log = [n \in Nodes |-> << >>]
  /\ commitIndex = [n \in Nodes |-> 0]
  /\ lastApplied = [n \in Nodes |-> 0]
  /\ nextIndex = [n \in Nodes |-> [n2 \in Nodes |-> 1]]
  /\ matchIndex = [n \in Nodes |-> [n2 \in Nodes |-> 0]]
  /\ config = [n \in Nodes |-> {}]
  /\ transitional = [n \in Nodes |-> FALSE]
  /\ leaderNode = [n \in Nodes |-> None]

\* ---- Actions ----
\* tla-rs does not support EXCEPT; all actions use IF-THEN-ELSE reconstruction.

BecomeFollower ==
  \E n \in Nodes, t \in Term :
    /\ t > currentTerm[n]
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "follower" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN t ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE votedFor[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE leaderNode[n2]]
    /\ UNCHANGED <<log, commitIndex, lastApplied, nextIndex, matchIndex,
                    config, transitional>>

RequestVote ==
  \E n \in Nodes :
    /\ serverState[n] \in {"follower", "candidate"}
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "candidate" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN currentTerm[n] + 1 ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE votedFor[n2]]
    /\ UNCHANGED <<log, commitIndex, lastApplied, nextIndex, matchIndex,
                    config, transitional, leaderNode>>

GrantVote ==
  \E voter \in Nodes, candidate \in Nodes :
    /\ voter # candidate
    /\ serverState[voter] \in {"follower", "candidate"}
    /\ currentTerm[candidate] >= currentTerm[voter]
    /\ (votedFor[voter] = None \/ votedFor[voter] = candidate)
    /\ votedFor' = [n \in Nodes |-> IF n = voter THEN candidate ELSE votedFor[n]]
    /\ UNCHANGED <<serverState, currentTerm, log, commitIndex,
                    lastApplied, nextIndex, matchIndex, config,
                    transitional, leaderNode>>

BecomeLeader ==
  \E n \in Nodes :
    /\ serverState[n] = "candidate"
    /\ Cardinality({n2 \in Nodes : votedFor[n2] = n}) >= Majority(Nodes)
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "leader" ELSE serverState[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE leaderNode[n2]]
    /\ nextIndex' = [n2 \in Nodes |-> IF n2 = n THEN [n3 \in Nodes |-> 1] ELSE nextIndex[n2]]
    /\ matchIndex' = [n2 \in Nodes |-> IF n2 = n THEN [n3 \in Nodes |-> 0] ELSE matchIndex[n2]]
    /\ UNCHANGED <<currentTerm, votedFor, log, commitIndex, lastApplied,
                    config, transitional>>

AppendEntries ==
  \E leader \in Nodes, follower \in Nodes :
    /\ serverState[leader] = "leader"
    /\ leader # follower
    /\ serverState[follower] \in {"follower", "candidate"}
    /\ currentTerm[leader] >= currentTerm[follower]
    /\ serverState' = [n \in Nodes |-> IF n = follower THEN "follower" ELSE serverState[n]]
    /\ currentTerm' = [n \in Nodes |-> IF n = follower THEN currentTerm[leader] ELSE currentTerm[n]]
    /\ leaderNode' = [n \in Nodes |-> IF n = follower THEN leader ELSE leaderNode[n]]
    /\ UNCHANGED <<votedFor, log, commitIndex, lastApplied, nextIndex,
                    matchIndex, config, transitional>>

CommitEntry ==
  \E n \in Nodes :
    /\ serverState[n] = "leader"
    /\ Len(log[n]) > 0
    /\ UNCHANGED <<serverState, currentTerm, votedFor, log, commitIndex,
                    lastApplied, nextIndex, matchIndex, config,
                    transitional, leaderNode>>

ProposeConfigChange ==
  \E n \in Nodes :
    /\ serverState[n] = "leader"
    /\ transitional[n] = FALSE
    /\ transitional' = [n2 \in Nodes |-> IF n2 = n THEN TRUE ELSE transitional[n2]]
    /\ UNCHANGED <<serverState, currentTerm, votedFor, log, commitIndex,
                    lastApplied, nextIndex, matchIndex, config, leaderNode>>

FinalizeTransition ==
  \E n \in Nodes :
    /\ serverState[n] = "leader"
    /\ transitional[n] = TRUE
    /\ transitional' = [n2 \in Nodes |-> IF n2 = n THEN FALSE ELSE transitional[n2]]
    /\ UNCHANGED <<serverState, currentTerm, votedFor, log, commitIndex,
                    lastApplied, nextIndex, matchIndex, config, leaderNode>>

\* ---- Safety Properties ----
\* Named NOT as Inv/TypeOK prefix to avoid tla-rs auto-detection issues

NoTwoLeaders ==
  \A n1, n2 \in Nodes, t \in Term :
    (serverState[n1] = "leader" /\ serverState[n2] = "leader" /\ n1 # n2)
    => currentTerm[n1] # t \/ currentTerm[n2] # t

CommitInBounds == \A n \in Nodes : commitIndex[n] <= lastApplied[n]

SafetyProperties ==
  /\ NoTwoLeaders
  /\ CommitInBounds

\* ---- Next ----

Next ==
  \/ BecomeFollower
  \/ RequestVote
  \/ GrantVote
  \/ BecomeLeader
  \/ AppendEntries
  \/ CommitEntry
  \/ ProposeConfigChange
  \/ FinalizeTransition

vars == <<serverState, currentTerm, votedFor, log, commitIndex,
          lastApplied, nextIndex, matchIndex, config, transitional, leaderNode>>

Spec == Init /\ [][Next]_vars

====
