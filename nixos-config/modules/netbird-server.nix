# NetBird control plane on the Orange Pi, migrated from lubancat on 2026-10-08.
#
# Port 443 is shared: the voice bridge (sms-daemon) terminates its own TLS and
# renews its certificate over TLS-ALPN-01, so an nginx *stream* server routes by
# SNI without touching the bytes — `voice-bridge.itoken.world` to the bridge on
# 8443, everything else to nginx's own HTTPS listener on 8444. Both hops carry
# the PROXY protocol so the real client address survives for the bridge's
# Cloudflare allowlist and for NetBird's peer records.
#
# No coturn: NetBird's relay (over 443) is the fallback path, and its built-in
# STUN answers on 3478/udp. Port 80 is forwarded for the HTTP-01 certificate.
#
# Secrets are files under /var/lib/netbird-secrets, root-only, placed by hand
# during the migration and never part of this repository:
#   datastore-key       DataStoreEncryptionKey carried over from lubancat
#   oidc-client-secret  casdoor client secret for the NetBird application
#   relay-auth-secret   generated on the Pi; shared by management and relay
{ config, lib, pkgs, ... }:

let
  domain = "netbird.starslab.qzz.io";
  voiceDomain = config.services.sms-daemon.voiceBridgeDomain;
  voicePort = config.services.sms-daemon.voiceBridgePort;
  secrets = "/var/lib/netbird-secrets";
  oidc = {
    issuer = "https://casdoor.starslab.qzz.io";
    clientId = "b41aebf81a1368b2abb5";
    scope = "openid profile email offline_access";
  };
  relayPort = 33080;
  nginxHttpsPort = 8444;
in
{
  services.netbird.server = {
    enable = true;
    enableNginx = true;
    inherit domain;
    coturn.enable = false;

    management = {
      oidcConfigEndpoint = "${oidc.issuer}/.well-known/openid-configuration";
      disableAnonymousMetrics = true;
      settings = {
        DataStoreEncryptionKey = { _secret = "${secrets}/datastore-key"; };
        Stuns = [ { Proto = "udp"; URI = "stun:${domain}:3478"; Username = ""; Password = null; } ];
        # The TURN block the module adds by default would point at a coturn
        # that does not exist; clients fall back to the relay instead.
        TURNConfig = {
          TimeBasedCredentials = false;
          CredentialsTTL = "12h";
          # Unused with no TURN servers; a file only to keep it out of the store.
          Secret = { _secret = "${secrets}/relay-auth-secret"; };
          Turns = [ ];
        };
        Relay = {
          Addresses = [ "rels://${domain}:443/relay" ];
          CredentialsTTL = "24h";
          Secret = { _secret = "${secrets}/relay-auth-secret"; };
        };
        HttpConfig = {
          AuthIssuer = oidc.issuer;
          AuthAudience = oidc.clientId;
          AuthUserIDClaim = "sub";
        };
        DeviceAuthorizationFlow = {
          Provider = "hosted";
          ProviderConfig = {
            Audience = oidc.clientId;
            ClientID = oidc.clientId;
            ClientSecret = { _secret = "${secrets}/oidc-client-secret"; };
            Domain = "casdoor.starslab.qzz.io";
            Scope = oidc.scope;
            UseIDToken = false;
            TokenEndpoint = "${oidc.issuer}/api/login/oauth/access_token";
            DeviceAuthEndpoint = "${oidc.issuer}/api/device-auth";
          };
        };
        PKCEAuthorizationFlow.ProviderConfig = {
          Audience = oidc.clientId;
          ClientID = oidc.clientId;
          ClientSecret = { _secret = "${secrets}/oidc-client-secret"; };
          Domain = "casdoor.starslab.qzz.io";
          AuthorizationEndpoint = "${oidc.issuer}/login/oauth/authorize";
          TokenEndpoint = "${oidc.issuer}/api/login/oauth/access_token";
          Scope = oidc.scope;
          RedirectURLs = [ "http://localhost:53000/" "http://localhost:54000/" ];
          UseIDToken = false;
        };
      };
    };

    dashboard.settings = {
      AUTH_AUTHORITY = oidc.issuer;
      AUTH_CLIENT_ID = oidc.clientId;
      AUTH_AUDIENCE = oidc.clientId;
      AUTH_SUPPORTED_SCOPES = oidc.scope;
      AUTH_REDIRECT_URI = "/auth";
      AUTH_SILENT_REDIRECT_URI = "/silent-auth";
      NETBIRD_TOKEN_SOURCE = "accessToken";
      NETBIRD_DRAG_QUERY_PARAMS = true;
    };
  };

  services.netbird.relay = {
    enable = true;
    authSecretFile = "${secrets}/relay-auth-secret";
    settings = {
      listen-address = "127.0.0.1:${toString relayPort}";
      exposed-address = "rels://${domain}:443/relay";
      enable-stun = true;
      stun-ports = [ 3478 ];
    };
  };

  security.acme.acceptTerms = true;

  services.nginx = {
    recommendedProxySettings = true;
    recommendedTlsSettings = true;

    # SNI router on 443. ssl_preread looks at the ClientHello only; the TLS
    # session itself is terminated by whichever backend the name selects.
    streamConfig = ''
      map $ssl_preread_server_name $sni_backend {
        ${voiceDomain} 127.0.0.1:${toString voicePort};
        default        127.0.0.1:${toString nginxHttpsPort};
      }
      server {
        listen 0.0.0.0:443;
        ssl_preread on;
        proxy_pass $sni_backend;
        proxy_protocol on;
        proxy_connect_timeout 5s;
      }
    '';

    virtualHosts.${domain} = {
      enableACME = true;
      forceSSL = true;
      listen = [
        { addr = "0.0.0.0"; port = 80; }
        { addr = "127.0.0.1"; port = nginxHttpsPort; ssl = true; proxyProtocol = true; }
      ];
      extraConfig = ''
        set_real_ip_from 127.0.0.1;
        real_ip_header proxy_protocol;
        client_header_timeout 1d;
        client_body_timeout 1d;
      '';
      locations = {
        "/relay" = {
          proxyPass = "http://127.0.0.1:${toString relayPort}";
          proxyWebsockets = true;
          extraConfig = "proxy_read_timeout 1d;";
        };
        # WebSocket fallbacks newer clients use where gRPC is blocked.
        "/ws-proxy/management" = {
          proxyPass = "http://127.0.0.1:${toString config.services.netbird.server.management.port}";
          proxyWebsockets = true;
          extraConfig = "proxy_read_timeout 1d;";
        };
        "/ws-proxy/signal" = {
          proxyPass = "http://127.0.0.1:${toString config.services.netbird.server.signal.port}";
          proxyWebsockets = true;
          extraConfig = "proxy_read_timeout 1d;";
        };
      };
    };
  };

  services.sms-daemon = {
    voiceBridgePort = 8443;
    voiceBridgeBehindProxy = true;
  };

  # The secrets directory outlives any service; the files inside are placed by
  # the migration runbook (docs/netbird-migration.md) and are root-only.
  systemd.tmpfiles.rules = [ "d ${secrets} 0700 root root -" ];
}
