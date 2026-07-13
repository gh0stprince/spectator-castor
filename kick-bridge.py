#!/usr/bin/env python3
"""Kick Chat Webhook Receiver + Chat Responder
Listens for Kick webhook events, feeds them to Spectator, and can respond in chat.
"""
import json, os, sys, hmac, hashlib, logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("kick-bridge")

# Config
HOME = os.path.expanduser("~")
KICK_TOKEN_PATH = os.path.join(HOME, ".kick-bridge-tokens.json")
SPECTATOR_URL = os.environ.get("SPECTATOR_URL", "http://127.0.0.1:8787")
BROADCASTER_ID = os.environ.get("KICK_BROADCASTER_ID")

def load_tokens():
    with open(KICK_TOKEN_PATH) as f:
        return json.load(f)

def refresh_token(tokens):
    """Refresh the access token using refresh_token."""
    resp = requests.post("https://id.kick.com/oauth/token", data={
        "grant_type": "refresh_token",
        "client_id": tokens["client_id"],
        "client_secret": tokens["client_secret"],
        "refresh_token": tokens["refresh_token"],
    })
    if resp.status_code == 200:
        new = resp.json()
        tokens["access_token"] = new["access_token"]
        tokens["refresh_token"] = new.get("refresh_token", tokens["refresh_token"])
        tokens["expires_in"] = new["expires_in"]
        with open(KICK_TOKEN_PATH, "w") as f:
            json.dump(tokens, f, indent=2)
        log.info("Token refreshed")
        return tokens["access_token"]
    log.error(f"Token refresh failed: {resp.status_code} {resp.text}")
    return None

def send_chat(message, reply_to=None, tokens=None):
    """Send a message to the Kick chat."""
    if tokens is None:
        tokens = load_tokens()
    
    access_token = tokens.get("access_token")
    
    payload = {
        "content": message[:500],
        "type": "user",
        "broadcaster_user_id": int(BROADCASTER_ID),
    }
    if reply_to:
        payload["reply_to_message_id"] = reply_to
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    
    resp = requests.post("https://api.kick.com/public/v1/chat",
        headers=headers, json=payload)
    
    if resp.status_code == 401:
        # Token expired, refresh and retry
        new_token = refresh_token(tokens)
        if new_token:
            headers["Authorization"] = f"Bearer {new_token}"
            resp = requests.post("https://api.kick.com/public/v1/chat",
                headers=headers, json=payload)
    
    if resp.status_code == 200:
        log.info(f"Chat sent: {message[:60]}...")
        return resp.json().get("data", {})
    else:
        log.error(f"Chat send failed: {resp.status_code} {resp.text[:200]}")
        return None

def push_spectator(kind, payload, actor_type="human", actor_name=None):
    """Push an event to Spectator's ingest endpoint."""
    import time, random
    
    if actor_type == "human":
        actor_name = actor_name or "Kick Chat"
        actor_id = "kick-chat"
    else:
        actor_name = actor_name or "Castor"
        actor_id = "agent"
    
    ts = int(time.time() * 1000)
    event = {
        "id": f"{ts}-{random.randint(0,9999)}",
        "ts": ts,
        "sessionId": "castor-live",
        "seq": 0,
        "actor": {"type": actor_type, "id": actor_id, "name": actor_name},
        "kind": kind,
        "payload": payload,
    }
    
    try:
        resp = requests.post(f"{SPECTATOR_URL}/ingest",
            headers={"Content-Type": "application/json"},
            json=event, timeout=2)
        return resp.ok
    except Exception as e:
        log.warning(f"Spectator push failed: {e}")
        return False

class WebhookHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"kick-bridge alive")
            return
        self.send_response(404)
        self.end_headers()
    
    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len)
        
        # Verify signature if Kick-Event-Signature header present
        event_type = self.headers.get("Kick-Event-Type", "")
        event_version = self.headers.get("Kick-Event-Version", "")
        
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        
        log.info(f"Webhook event: {event_type} v{event_version}")
        
        if event_type == "chat.message.sent":
            self._handle_chat_message(payload)
        elif event_type == "channel.followed":
            self._handle_follow(payload)
        elif event_type == "livestream.status.updated":
            self._handle_stream_status(payload)
        else:
            log.info(f"Unhandled event type: {event_type}")
        
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True}).encode())
    
    def _handle_chat_message(self, payload):
        sender = payload.get("sender", {})
        content = payload.get("content", "")
        message_id = payload.get("message_id", "")
        username = sender.get("username", "unknown")
        
        # Strip emote codes for display
        clean_content = content
        import re
        clean_content = re.sub(r'\[emote:\d+:[^\]]*\]', '(emote)', clean_content)
        
        log.info(f"Chat from {username}: {clean_content[:100]}")
        
        # Push to Spectator so viewers see it
        push_spectator("user.message", {"text": f"[Kick] {username}: {clean_content}"}, 
                       actor_type="human", actor_name=username)
    
    def _handle_follow(self, payload):
        follower = payload.get("follower", {})
        username = follower.get("username", "unknown")
        log.info(f"Follow from {username}")
        push_spectator("user.message", {"text": f"🎉 {username} followed!"},
                       actor_type="human", actor_name=username)
    
    def _handle_stream_status(self, payload):
        broadcaster = payload.get("broadcaster", {})
        status = payload.get("status", "unknown")
        log.info(f"Stream status: {status} for {broadcaster.get('username', '?')}")
        push_spectator("status", {"state": "live" if status == "started" else "idle",
                                  "detail": f"Stream {status}"})
    
    def log_message(self, format, *args):
        log.info(f"HTTP {args[0]} {args[1]}")

def subscribe_to_events(webhook_url, tokens):
    """Subscribe to chat.message.sent events via webhook."""
    headers = {
        "Authorization": f"Bearer {tokens['access_token']}",
        "Content-Type": "application/json",
    }
    
    # First check if webhook is configured in Kick app settings
    # The webhook URL needs to be set in the Kick Developer tab first
    
    # Subscribe to events via API
    payload = {
        "events": [
            {"name": "chat.message.sent", "version": 1},
            {"name": "channel.followed", "version": 1},
            {"name": "livestream.status.updated", "version": 1},
        ],
        "method": "webhook",
    }
    
    resp = requests.post("https://api.kick.com/public/v1/events/subscriptions",
        headers=headers, json=payload)
    
    if resp.status_code == 200:
        data = resp.json()
        log.info(f"Subscribed to events: {json.dumps(data, indent=2)}")
        return data
    else:
        log.error(f"Subscription failed: {resp.status_code} {resp.text[:300]}")
        # It might fail because the webhook URL isn't set yet in the app settings
        return None

def list_subscriptions(tokens):
    """List current event subscriptions."""
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    resp = requests.get("https://api.kick.com/public/v1/events/subscriptions",
        headers=headers)
    if resp.status_code == 200:
        return resp.json()
    return None

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Kick Chat Bridge")
    parser.add_argument("--port", type=int, default=8765, help="Webhook listener port")
    parser.add_argument("--webhook-url", help="Public webhook URL (for subscription)")
    parser.add_argument("--subscribe", action="store_true", help="Subscribe to events after starting")
    parser.add_argument("--list-subs", action="store_true", help="List current subscriptions")
    parser.add_argument("--test-chat", help="Send a test chat message")
    args = parser.parse_args()
    
    tokens = load_tokens()
    
    if args.list_subs:
        subs = list_subscriptions(tokens)
        print(json.dumps(subs, indent=2))
        sys.exit(0)
    
    if args.test_chat:
        result = send_chat(args.test_chat, tokens=tokens)
        print(json.dumps(result, indent=2))
        sys.exit(0)
    
    if args.subscribe and args.webhook_url:
        subscribe_to_events(args.webhook_url, tokens)
    
    server = HTTPServer(("127.0.0.1", args.port), WebhookHandler)
    log.info(f"Kick Bridge listening on http://127.0.0.1:{args.port}")
    log.info(f"Send a test: python3 {sys.argv[0]} --test-chat 'hello world'")
    
    if args.webhook_url:
        log.info(f"Configure this URL in your Kick app's webhook settings: {args.webhook_url}")
        log.info("Then restart with --subscribe to register event subscriptions.")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
        server.server_close()
