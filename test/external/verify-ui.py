"""Optional UI check: run the separate loopback UI fixture after bun run build:web.
uv run --with playwright python test/external/verify-ui.py
No real data/provider calls. No credential value is printed or saved in screenshots.
"""
import re
import argparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("--origin", default="http://127.0.0.1:8799")
origin = parser.parse_args().origin
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1280, "height": 1000})
    assert context.request.post(origin + "/fixture/seed", data={}).ok
    assert context.request.post(origin + "/fixture/session/owner", data={}).ok
    page = context.new_page()
    page.goto(origin + "/configure/external-access")
    expect(page.get_by_role("heading", name="External Access", exact=True)).to_be_visible()
    expect(page.get_by_text("MCP connection URL:")).to_be_visible()
    page.get_by_label("Integration label").fill("Fictional browser integration")
    page.get_by_label(re.compile("Expires in days")).fill("1")
    page.get_by_label("I authorize shared-company data disclosure to this external agent/provider.").check()
    page.get_by_role("button", name="Create credential").click()
    secret_field = page.get_by_label("One-time bearer credential")
    expect(secret_field).to_be_visible()
    secret = secret_field.input_value()
    assert secret.startswith("sd_ext_")
    assert not page.evaluate("secret => JSON.stringify({...localStorage, ...sessionStorage}).includes(secret)", secret)
    page.reload()
    expect(page.get_by_text("Fictional browser integration", exact=True)).to_be_visible()
    expect(secret_field).not_to_be_visible()
    page.on("dialog", lambda dialog: dialog.accept())
    page.get_by_role("button", name="Revoke", exact=True).click()
    expect(page.get_by_role("button", name="Revoke", exact=True)).to_be_disabled()
    expect(page.get_by_text(re.compile("revoked$"))).to_be_visible()
    page.screenshot(path="/tmp/sudopedia-external-access-ui.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.get_by_role("button", name="Create credential")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    page.screenshot(path="/tmp/sudopedia-external-access-mobile.png", full_page=True)
    assert context.request.post(origin + "/fixture/session/member", data={}).ok
    page.reload()
    expect(page.get_by_text("Only organization owners/admins can manage external access.")).to_be_visible()
    expect(page.get_by_role("button", name="Create credential")).not_to_be_visible()
    browser.close()
print("PASS UI: canonical URL, consent, mint/list/revoke, one-time secret not persisted, reload hides secret, mobile layout, member restriction")
