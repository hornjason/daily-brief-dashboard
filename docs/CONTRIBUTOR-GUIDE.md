---
doc-type: reference
status: active
owner: jason
updated: 2026-08-19
---

# Contributor Guide: Exploring the Brief Encounters Platform

This guide walks you through the demo environment so you can see how signals flow through the intelligence pipeline. No coding or terminal experience is required.

## What You Will See

The Brief Encounters platform collects signals from multiple sources (support cases, emails, subscriptions, account intelligence) and weaves them into a daily brief for each customer account. The CrowdStrike account is our demo baseline because it has the richest signal coverage: 19 support cases, 17 email threads, 6 subscriptions, and 153 cross-reference connections.

## Before You Start

Make sure the demo environment is running. You should be able to open your browser and navigate to the dashboard. If you cannot reach the dashboard, ask your team lead to start the demo server.

## Step-by-Step: View, Inject, and Compare

### Step 1: Open the Demo Dashboard

Open your browser and navigate to the demo dashboard at `http://localhost:7779`. You will see the portfolio overview page showing all demo accounts as cards in a grid.

### Step 2: View the CrowdStrike Baseline Brief

Click on the **CrowdStrike** account card in the dashboard grid. This opens the customer detail page. Scroll down to read the current daily brief. This is the "before" state -- what the platform generates from the existing baseline signals.

Take note of:
- Which support cases are highlighted
- What themes appear in the brief narrative
- How many cross-reference connections are shown in the intelligence graph

You can compare what you see on screen with the frozen baseline in `data-demo/baselines/crowdstrike/BASELINE-INFO.md`, which documents the exact signal counts captured before any changes.

### Step 3: Review the Sample Signal

Open the file `data-demo/samples/sample-case-injection.json` in any text editor or viewer. This is a pre-built support case about an OpenShift networking failure at CrowdStrike. It was designed to trigger cross-references with:

- CrowdStrike's existing OpenShift subscription (renewal urgency)
- The email thread with Sri Harsha Panchali (contact match)
- Existing OpenShift cases on the same cluster (pattern detection)

### Step 4: Inject the Sample Signal

To add the sample case into the demo pipeline:

1. Open the file `data-demo/cache/cases.json` in a text editor
2. Find the `"cases"` array (it starts near the top of the file)
3. Copy the `"case"` object from `sample-case-injection.json` and paste it as a new entry at the end of the `"cases"` array
4. Save the file

Alternatively, ask your team lead or a developer to inject the signal for you.

### Step 5: Trigger a Pipeline Refresh

Navigate back to the dashboard in your browser. Open the **Admin** page by clicking the gear icon in the sidebar. Click the **Refresh** button to trigger the pipeline to re-process all signals, including the newly injected case.

Wait for the refresh to complete. The dashboard will show a progress indicator while the pipeline runs.

### Step 6: Compare Before and After

Navigate back to the CrowdStrike account page by clicking on the CrowdStrike card. Read the updated daily brief and compare it with what you saw in Step 2:

- **New case highlighted**: The Severity 1 OpenShift networking case should appear prominently in the brief
- **Cross-references**: The intelligence graph should show new connections between the injected case and existing signals (OpenShift subscription, email contacts, related cases)
- **Brief narrative**: The daily brief text should now reference the networking issue and its business impact on CrowdStrike's security operations

### Step 7: Explore Further

Now that you have seen a signal flow through the pipeline, try exploring other parts of the dashboard:

- **Intelligence Graph**: Click the graph visualization to see how signals connect to each other. The injected case should have created new edges to existing nodes.
- **Other Accounts**: Click on other demo account cards to see how different signal patterns produce different briefs.
- **Product View**: Toggle to the product view in the sidebar to see signals grouped by Red Hat product line (RHEL, OpenShift, Ansible) instead of by account.

## What to Look For

When evaluating the platform, consider:

- **Signal Coverage**: Does the brief capture all relevant signals for the account?
- **Cross-References**: Are connections between signals meaningful and actionable?
- **Brief Quality**: Is the narrative useful for preparing for a customer meeting?
- **Missing Signals**: What information sources would make the brief more complete?

## Providing Feedback

After exploring the demo, share your observations with the team. The most valuable feedback covers:

1. What was surprising or unexpected in the brief
2. What information was missing that you would need for a real customer conversation
3. Which cross-references were most useful and which felt like noise
4. Ideas for new signal sources or brief sections

Open an issue on the project repository or bring your feedback to the next team meeting.
