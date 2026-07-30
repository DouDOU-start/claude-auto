export async function extractGrokSession(cdp) {
  const result = await cdp.send("Network.getCookies", {
    urls: ["https://grok.com/", "https://accounts.x.ai/"],
  });
  const cookies = result.cookies || [];
  const interesting = cookies.filter((cookie) =>
    /^(sso|sso-rw|x-userid|x-anonuserid|x-signature|x-challenge|grok_device_id|cf_clearance)$/i.test(
      cookie.name,
    ),
  );

  return {
    userId: cookieValue(cookies, "x-userid", "grok.com"),
    anonymousUserId: cookieValue(cookies, "x-anonuserid", "grok.com"),
    deviceId: cookieValue(cookies, "grok_device_id", "grok.com"),
    sessionToken: cookieValue(cookies, "sso", "x.ai"),
    sessionTokenRw: cookieValue(cookies, "sso-rw", "x.ai"),
    cookies: interesting,
  };
}

function cookieValue(cookies, name, preferredDomain) {
  return (
    cookies.find((cookie) => cookie.name === name && cookie.domain.includes(preferredDomain))?.value ||
    cookies.find((cookie) => cookie.name === name)?.value ||
    ""
  );
}
