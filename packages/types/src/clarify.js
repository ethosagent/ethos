// @ethosagent/types — clarify protocol
//
// The `clarify` tool lets an agent ask the user a structured question
// mid-turn, wait for the answer, and continue — replacing the "guess wrong,
// burn turns recovering" failure mode. See plan/phases/tool_clarity_plan.md.
//
// A clarify request blocks the issuing tool until the user answers, a timeout
// fires (returning `default`), or the user cancels. Pending state is persisted
// so async surfaces and browser refreshes survive a restart.
export {};
