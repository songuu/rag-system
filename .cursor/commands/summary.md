<!--
 * @Author: songuu 1101309860@qq.com
 * @Date: 2026-02-02 15:26:48
 * @LastEditors: songuu 1101309860@qq.com
 * @LastEditTime: 2026-02-02 15:26:52
 * @FilePath: \project\.cursor\commands\summary.md
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
-->
# Role: Context Compression Specialist & System Architect

## Objective
Analyze the entire conversation history to perform a "Context Distillation".
Your goal is to generate a structured "Bridge Prompt" that captures the **Intelligence**, **Constraints**, and **Current State** of this session.
This output will be used to initialize a FRESH chat session, allowing the user to reset token usage while maintaining perfect continuity.

## 🧠 Analysis Framework (Think step-by-step)

1.  **Prompt Engineering Audit**:
    * Identify implicit rules the user enforced (e.g., "User prefers functional components", "Environment is Windows/PowerShell").
    * Capture specific libraries/versions mandated (e.g., "Supabase v2", "React 19", "pnpm only").

2.  **Solution Evolution Analysis**:
    * **The Problem**: What was the original request?
    * **The Journey**: What solutions were tried and **REJECTED**? (Crucial to prevent loops).
    * **The Solution**: What is the current agreed-upon architectural path?

3.  **Code State Snapshot**:
    * List the files currently being modified.
    * Identify the exact step where we paused (e.g., "Dependency installed, config file created, pending integration").

## 📤 Output Artifact: The "Bridge Prompt"

You must output a SINGLE code block containing a prompt that the user can copy-paste into a new chat.
Format:

```markdown
# 🔄 SESSION RESTORATION PROTOCOL

## 1. System Context & Constraints
You are continuing a complex development task. Adopt the following constraints immediately:
- **Environment**: [e.g., Windows 11, PowerShell, Node v20]
- **Tech Stack**: [List exact versions, e.g., Next.js 15 (App Router), Tailwind 4, Supabase]
- **User Preferences**:
  - [Constraint 1: e.g., No 'any' types, strict TypeScript]
  - [Constraint 2: e.g., Use 'lucide-react' for icons]

## 2. Knowledge Graph (The "Why")
- **Goal**: [Brief summary of the ultimate objective]
- **Architecture Decisions**:
  - [Decision 1]: Selected X over Y because [Reason]
  - [Decision 2]: Implemented pattern Z
- **⛔ FAILED PATHS (Do Not Repeat)**:
  - We already tried [Approach A] and it failed due to [Error].
  - Do not suggest [Library B].

## 3. Current Execution State (The "Where")
We are currently focusing on:
- **Active Files**: `[File Path 1]`, `[File Path 2]`
- **Last Action**: [What was just done? e.g., "Fixed the hydration error"]
- **Blocking Issue**: [Is there an active error? Paste it here]

## 4. Immediate Next Step Instruction
Your first task in this new session is:
[Specific, actionable instruction, e.g., "Generate the API route handler based on the schema defined in `supabase/types.ts`"]