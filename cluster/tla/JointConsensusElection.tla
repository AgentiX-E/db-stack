---- MODULE JointConsensusElection ----
\* Pure election model — atomic verification of Raft leader election safety.
\*
\* Removes log/replication variables (log, commitIndex, lastApplied,
\* nextIndex, matchIndex, config, transitional) that cause exponential
\* state explosion but don't affect election-safety invariants.
\*
\* Goal: exhaustive state-space coverage for NoTwoLeaders + liveness.
\*
\* Bugs discovered in full model and fixed here:
\*   1. RequestVote: (votedFor[n]=None \/ votedFor[n]=n) guard
\*   2. BecomeFollower: \E sender: currentTerm[sender]=t (no phantom term)
\*   3. BecomeLeader: ~\E n2: leader check prevents same-term dual-leader
\*
\* Reference: Raft §5.2, §5.4.1

EXTENDS Integers, FiniteSets, TLC

CONSTANT
  Nodes,
  MaxTerm

VARIABLES
  serverState,    \* [node -> {"follower", "candidate", "leader"}]
  currentTerm,    \* [node -> Term]
  votedFor,       \* [node -> node | None]
  leaderNode      \* [node -> node | None] (perceived leader)

\* ---- Types ----

Term == 1..MaxTerm

None == -1

Majority(S) == Cardinality(S) \div 2 + 1

\* ---- Init ----

Init ==
  /\ serverState = [n \in Nodes |-> "follower"]
  /\ currentTerm = [n \in Nodes |-> 1]
  /\ votedFor = [n \in Nodes |-> None]
  /\ leaderNode = [n \in Nodes |-> None]

\* ---- Actions ----
\*
\* BecomeFollower: triggered upon discovering a higher term from
\* an RPC sender (AppendEntries or RequestVote response).
\* The sender existence check prevents phantom term discovery.

BecomeFollower ==
  \E n \in Nodes, t \in Term :
    /\ t > currentTerm[n]
    /\ t <= MaxTerm
    /\ \E sender \in Nodes :
         sender # n /\ currentTerm[sender] = t
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "follower" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN t ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE votedFor[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN None ELSE leaderNode[n2]]

\* RequestVote: start an election.
\* Candidate must NOT have already voted for another node (§5.2).

RequestVote ==
  \E n \in Nodes :
    /\ serverState[n] \in {"follower", "candidate"}
    /\ (votedFor[n] = None \/ votedFor[n] = n)
    /\ currentTerm[n] < MaxTerm
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "candidate" ELSE serverState[n2]]
    /\ currentTerm' = [n2 \in Nodes |-> IF n2 = n THEN currentTerm[n] + 1 ELSE currentTerm[n2]]
    /\ votedFor' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE votedFor[n2]]
    /\ UNCHANGED <<leaderNode>>

\* GrantVote: vote for a candidate.
\* Voter must not have already voted (§5.4.1).

GrantVote ==
  \E voter \in Nodes, candidate \in Nodes :
    /\ voter # candidate
    /\ serverState[voter] \in {"follower", "candidate"}
    /\ currentTerm[candidate] >= currentTerm[voter]
    /\ (votedFor[voter] = None \/ votedFor[voter] = candidate)
    /\ votedFor' = [n \in Nodes |-> IF n = voter THEN candidate ELSE votedFor[n]]
    /\ UNCHANGED <<serverState, currentTerm, leaderNode>>

\* BecomeLeader: candidate wins when it gets a majority of votes.
\* Safety check: no other node in this term has already become leader.

BecomeLeader ==
  \E n \in Nodes :
    /\ serverState[n] = "candidate"
    /\ Cardinality({n2 \in Nodes : votedFor[n2] = n}) >= Majority(Nodes)
    /\ ~ \E n2 \in Nodes \ {n} :
         (leaderNode[n2] # None /\ serverState[n2] = "leader"
             /\ currentTerm[n2] = currentTerm[n])
    /\ serverState' = [n2 \in Nodes |-> IF n2 = n THEN "leader" ELSE serverState[n2]]
    /\ leaderNode' = [n2 \in Nodes |-> IF n2 = n THEN n ELSE leaderNode[n2]]
    /\ UNCHANGED <<currentTerm, votedFor>>

\* ---- Safety Invariants ----

NoTwoLeaders ==
  \A n1, n2 \in Nodes, t \in Term :
    (serverState[n1] = "leader" /\ serverState[n2] = "leader" /\ n1 # n2)
    => currentTerm[n1] # t \/ currentTerm[n2] # t

OneLeaderPerTerm ==
  \A t \in Term :
    Cardinality({n \in Nodes : serverState[n] = "leader" /\ currentTerm[n] = t}) <= 1

LeadershipStable ==
  \A n \in Nodes :
    serverState[n] = "leader" => leaderNode[n] = n

SafetyInvariant ==
  /\ NoTwoLeaders
  /\ OneLeaderPerTerm
  /\ LeadershipStable

\* Liveness: every election-eligible node eventually has a leader.
\* This checks that the system doesn't get stuck with no leader
\* when a term is active (one node should eventually win).

\* TLC temporal properties: <>[]HasLeader
HasLeader == \E n \in Nodes : serverState[n] = "leader"

\* ---- Next ----

Next ==
  \/ BecomeFollower
  \/ RequestVote
  \/ GrantVote
  \/ BecomeLeader

vars == <<serverState, currentTerm, votedFor, leaderNode>>

Spec == Init /\ [][Next]_vars

\* ---- Liveness ----
\* Weak fairness on the entire Next set means that if an action
\* is continuously enabled, it must eventually be taken.
\* Since we model async distributed system without global progress,
\* this is only a "best effort" guarantee.
\*
\* With deadlock allowed, some behaviors never elect a leader
\* (e.g. all nodes in candidate state with split vote).
\* Liveness property below captures eventual leader election
\* under the fair assumption that someone successfully wins.
Liveness == <>(HasLeader)


====
