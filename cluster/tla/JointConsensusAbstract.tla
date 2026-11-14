---- MODULE JointConsensusAbstract ----
EXTENDS Integers, FiniteSets, TLC

\* Abstract model: focuses on leader election safety only.
\* nextIndex/matchIndex/commitIndex are implementation machinery
\* that don't affect the leader-election safety invariants.

CONSTANT
  Nodes,
  MaxTerm

VARIABLES
  serverState,
  currentTerm,
  votedFor,
  leaderNode

Term == 1..MaxTerm

None == -1

Majority(S) == Cardinality(S) \div 2 + 1

Init ==
  /\ serverState = [n \in Nodes |-> "follower"]
  /\ currentTerm = [n \in Nodes |-> 1]
  /\ votedFor = [n \in Nodes |-> None]
  /\ leaderNode = [n \in Nodes |-> None]

\* ---- Actions ----

BecomeFollower ==
  \E n \in Nodes, t \in Term :
    /\ t > currentTerm[n]
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "follower" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN t ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE votedFor[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE leaderNode[n2]]

RequestVote ==
  \E n \in Nodes :
    /\ serverState[n] \in {"follower", "candidate"}
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "candidate" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN currentTerm[n] + 1 ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE votedFor[n2]]
    /\ UNCHANGED <<leaderNode>>

GrantVote ==
  \E voter \in Nodes, candidate \in Nodes :
    /\ voter # candidate
    /\ serverState[voter] \in {"follower", "candidate"}
    /\ currentTerm[candidate] >= currentTerm[voter]
    /\ (votedFor[voter] = None \/ votedFor[voter] = candidate)
    /\ votedFor' = [n \in Nodes |-> IF n = voter THEN candidate ELSE votedFor[n]]
    /\ UNCHANGED <<serverState, currentTerm, leaderNode>>

BecomeLeader ==
  \E n \in Nodes :
    /\ serverState[n] = "candidate"
    /\ Cardinality({n2 \in Nodes : votedFor[n2] = n}) >= Majority(Nodes)
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "leader" ELSE serverState[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE leaderNode[n2]]
    /\ UNCHANGED <<currentTerm, votedFor>>

\* ---- Safety Properties ----

NoTwoLeaders ==
  \A n1, n2 \in Nodes, t \in Term :
    (serverState[n1] = "leader" /\ serverState[n2] = "leader" /\ n1 # n2)
    => currentTerm[n1] # t \/ currentTerm[n2] # t

LeaderIsCandidate ==
  \A n \in Nodes : serverState[n] = "leader" => serverState[n] = "leader"

OneLeaderPerTerm ==
  \A t \in Term :
    Cardinality({n \in Nodes : serverState[n] = "leader" /\ currentTerm[n] = t}) <= 1

SafetyInvariant ==
  /\ NoTwoLeaders
  /\ OneLeaderPerTerm

Next ==
  \/ BecomeFollower
  \/ RequestVote
  \/ GrantVote
  \/ BecomeLeader

vars == <<serverState, currentTerm, votedFor, leaderNode>>

Spec == Init /\ [][Next]_vars

====
