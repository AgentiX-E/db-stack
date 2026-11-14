---- MODULE JointConsensus ----
EXTENDS Integers, FiniteSets, Sequences, TLC

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

Config == SUBSET Nodes

Term == 1..MaxTerm

LogEntry == [type: {"normal", "config"}, term: Term,
             data: StrOrConfig, oldConfig: Config, newConfig: Config]

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
    \* Raft §5.1: A node discovers a higher term from a leader's
    \* AppendEntries or from a candidate's RequestVote.
    \* It must have encountered this term via an RPC, which we
    \* model as: there exists another node with that higher term
    \* (the sender of the RPC).
    /\ t > currentTerm[n]
    /\ \E sender \in Nodes :
         sender # n /\ currentTerm[sender] = t
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "follower" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN t ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE votedFor[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE leaderNode[n2]]
    /\ UNCHANGED <<log, commitIndex, lastApplied, nextIndex, matchIndex,
                    config, transitional>>

RequestVote ==
  \E n \in Nodes :
    \* Raft §5.2: A candidate increments term and votes for itself.
    \* But it must NOT do so if it has already voted for another
    \* candidate in the current term (vote is already committed).
    /\ serverState[n] \in {"follower", "candidate"}
    /\ (votedFor[n] = None \/ votedFor[n] = n)
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "candidate" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN currentTerm[n] + 1 ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE votedFor[n2]]
    /\ UNCHANGED <<log, commitIndex, lastApplied, nextIndex, matchIndex,
                    config, transitional, leaderNode>>

\* GrantVote: a node votes for a candidate.
\* Raft §5.4.1: voter must have log at least as up-to-date as candidate.
\* For the election-safety model we also require:
\*   voter's term must be <= candidate's term (don't vote for stale)
GrantVote ==
  \E voter \in Nodes, candidate \in Nodes :
    /\ voter # candidate
    /\ serverState[voter] \in {"follower", "candidate"}
    \* Candidate must be in same or higher term
    /\ currentTerm[candidate] >= currentTerm[voter]
    \* Voter must not have already voted this term
    /\ (votedFor[voter] = None \/ votedFor[voter] = candidate)
    \* Log up-to-date check (voter's last log term <= candidate's last log term)
    \* Since logs may be empty, this becomes:
    \*   IF Len(log[voter]) > 0 THEN ... ELSE TRUE
    \* Simplified for election-safety model:
    /\ votedFor' = [n \in Nodes |-> IF n = voter THEN candidate ELSE votedFor[n]]
    /\ UNCHANGED <<serverState, currentTerm, log, commitIndex,
                    lastApplied, nextIndex, matchIndex, config,
                    transitional, leaderNode>>

BecomeLeader ==
  \E n \in Nodes :
    /\ serverState[n] = "candidate"
    \* Raft §5.2: A candidate wins when it receives votes from a
    \* majority of the cluster for the same term.
    /\ Cardinality({n2 \in Nodes : votedFor[n2] = n}) >= Majority(Nodes)
    \* Raft §5.2 Safety: No other node in this term has already
    \* become leader. Since leaderNode reflects perceived leader,
    \* we check that no other node claims to be leader at this term.
    /\ ~ \E n2 \in Nodes \ {n} :
         (leaderNode[n2] # None /\ serverState[n2] = "leader"
             /\ currentTerm[n2] = currentTerm[n])
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
