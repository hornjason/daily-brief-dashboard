#!/usr/bin/env python3
"""Compare Gemini 2.5 Flash vs 2.5 Pro for tech-stack extraction."""
import json, subprocess, time, urllib.request, ssl

PROJECT = "jhorn-pai"
LOCATION = "us-east1"
MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"]
CUSTOMERS = ["A10 Networks", "Fred Hutchinson Cancer Center", "Dropbox"]

SYSTEM_PROMPT = """You are a technology detection system. Research the company using Google Search. Find specific products and vendor tools, not generic categories.

Rules:
- Find SPECIFIC vendor products and tools (e.g., "Terraform" not "IaC", "ServiceNow" not "ITSM", "Jenkins" not "CI/CD")
- Classify each as "proprietary" (customer-built/specific) or "industry-tool" (widely used vendor/OSS)
- Context: "using" | "evaluating" | "migrating_from"
- Confidence: HIGH (explicitly mentioned in sources) | MEDIUM (strongly implied) | LOW (inferred)
- For each, include redHatProducts that complement: ocp, rhel, aap, acs, acm, satellite, rhdh, quay
- Include a "why" field: one sentence on why the customer uses this
- Skip generic programming languages (Python, Go, Bash, Java, etc.) unless they are part of a specific platform
- Return ONLY a valid JSON array, no markdown fences"""

def get_token():
    result = subprocess.run(
        ["gcloud", "auth", "print-access-token", "--scopes=https://www.googleapis.com/auth/cloud-platform"],
        capture_output=True, text=True
    )
    return result.stdout.strip()

def run_model(model, customer, token):
    url = f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/publishers/google/models/{model}:generateContent"

    user_prompt = f"""CUSTOMER: {customer}

Research {customer}'s technology stack using Google Search. Find job postings, case studies, partner announcements. Extract all technologies with evidence.

Return JSON array:
[{{"name":"...","category":"proprietary"|"industry-tool","context":"using"|"evaluating"|"migrating_from","confidence":"HIGH"|"MEDIUM"|"LOW","redHatProducts":["ocp","rhel"],"why":"one sentence"}}]

Return ONLY the JSON array."""

    body = {
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 8192},
        "tools": [{"googleSearch": {}}]
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST"
    )

    ctx = ssl.create_default_context()
    start = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "elapsed": time.time() - start}

    elapsed = time.time() - start

    if "error" in data:
        return {"error": data["error"].get("message", "?"), "elapsed": elapsed}

    parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts if "text" in p and not p.get("thought"))
    usage = data.get("usageMetadata", {})

    # Parse JSON
    try:
        cleaned = text.replace("```json", "").replace("```", "").strip()
        start_idx = cleaned.index("[")
        end_idx = cleaned.rindex("]") + 1
        techs = json.loads(cleaned[start_idx:end_idx])
    except Exception as e:
        return {"error": f"JSON parse: {e}", "raw": text[:200], "elapsed": elapsed}

    return {
        "techs": techs,
        "elapsed": elapsed,
        "inputTokens": usage.get("promptTokenCount", 0),
        "outputTokens": usage.get("candidatesTokenCount", 0),
    }

def main():
    token = get_token()

    print("═" * 60)
    print("  gemini-2.5-flash vs gemini-2.5-pro: Tech-Stack Extraction")
    print("═" * 60)

    for customer in CUSTOMERS:
        print(f"\n━━━ {customer} {'━' * (50 - len(customer))}\n")

        for model in MODELS:
            label = "CURRENT" if "flash" in model else "PRO"
            print(f"  ▸ {model} ({label}):")
            result = run_model(model, customer, token)

            if "error" in result:
                print(f"    ERROR: {result['error']}")
                if "raw" in result:
                    print(f"    Raw: {result['raw']}")
                print()
                continue

            techs = result["techs"]
            vendor = [t for t in techs if t.get("category") == "industry-tool"]
            propri = [t for t in techs if t.get("category") == "proprietary"]
            with_rh = [t for t in techs if t.get("redHatProducts") and len(t.get("redHatProducts", [])) > 0]

            print(f"    {result['elapsed']:.1f}s | {result['inputTokens']}in/{result['outputTokens']}out")
            print(f"    {len(techs)} technologies: {len(vendor)} vendor, {len(propri)} proprietary, {len(with_rh)} with RH mapping")
            print()

            for t in techs:
                rh = ",".join(t.get("redHatProducts", [])) if t.get("redHatProducts") else ""
                conf = t.get("confidence", "?")
                ctx = t.get("context", "?")
                icon = "●" if conf == "HIGH" else "◐" if conf == "MEDIUM" else "○"
                line = f"    {icon} {ctx:14s} {t.get('name', '?')}"
                if rh:
                    line += f" → [{rh}]"
                print(line)
                why = t.get("why", "")
                if why:
                    print(f"      {why[:90]}")

            print()

    print("═══ Comparison Complete ═══")

if __name__ == "__main__":
    main()
