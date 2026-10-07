/** Defense-in-depth for obvious credentials embedded in provider content.
 * This is not a general PII detector; source audiences remain the primary ACL. */
export function redactKnowledgeSecrets(text: string): string {
	return text
		.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "[private key redacted]")
		.replace(/\b(?:xox[abprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[credential redacted]")
		.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9_+.\/-]{8,}={0,2}/gi, "[authorization redacted]")
		.replace(/\b((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*)["']?[^\s"',;]{8,}["']?/gi, "$1[credential redacted]")
}
