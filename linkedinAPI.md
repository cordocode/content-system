# LinkedIn API Authentication - Lessons Learned

## The Problem

LinkedIn's developer portal has a token generator, but **it doesn't include the correct OAuth scopes** needed for posting content. This causes 403 "ACCESS_DENIED" errors even though you have "Share on LinkedIn" product access.

## Why the curl Command Failed

The initial test used `/v2/me` endpoint:
```bash
curl -X GET 'https://api.linkedin.com/v2/me' -H "Authorization: Bearer TOKEN"
```

**This failed with 403 because:**
1. The `/v2/me` endpoint requires the `r_liteprofile` or `profile` scope
2. The token generated from LinkedIn's portal didn't have the right scopes
3. Even tokens with `w_member_social` (posting permission) don't necessarily have profile read access

## The Solution: Manual OAuth Flow

### Required OAuth Scopes for Posting:
- `openid` - Basic authentication
- `profile` - Read profile data (for getting user URN)
- `w_member_social` - **POST content as yourself** (critical for posting)

### The Working OAuth Flow:

1. **Authorization URL** (user approves in browser):
```
https://www.linkedin.com/oauth/v2/authorization?
  response_type=code&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://www.linkedin.com/developers/tools/oauth/redirect&
  scope=openid%20profile%20w_member_social
```

2. **Exchange code for token** (programmatically):
```javascript
const params = new URLSearchParams({
  grant_type: 'authorization_code',
  code: CODE_FROM_REDIRECT,
  redirect_uri: 'https://www.linkedin.com/developers/tools/oauth/redirect',
  client_id: CLIENT_ID,
  client_secret: CLIENT_SECRET
});

const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params
});
```

## Why the Working Method Works

### Getting User Info:
```javascript
// ✅ This works with openid + profile scopes
const userInfo = await axios.get('https://api.linkedin.com/v2/userinfo', {
  headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}` }
});
// Returns: { sub: "Wo1iAAGDgB", ... }
```

**Key insight:** Use `/v2/userinfo` (OpenID Connect endpoint) instead of `/v2/me` (legacy endpoint). The `userinfo` endpoint works with the `openid` scope.

### Posting Content:
```javascript
// ✅ This works with w_member_social scope
const personUrn = `urn:li:person:${userInfo.data.sub}`;

await axios.post('https://api.linkedin.com/v2/ugcPosts', {
  author: personUrn,
  lifecycleState: 'PUBLISHED',
  specificContent: {
    'com.linkedin.ugc.ShareContent': {
      shareCommentary: { text: 'Your post content' },
      shareMediaCategory: 'NONE'
    }
  },
  visibility: {
    'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
  }
}, {
  headers: {
    'Authorization': `Bearer ${ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0'
  }
});
```

## Token Permissions Verification

A valid token for posting should show these permissions in LinkedIn's token inspector:
```
Permissions: openid, profile, w_member_social
Status: OAuth token is active
```

## Important Notes

1. **Token Expiration:** LinkedIn access tokens expire after ~60 days
2. **Refresh Tokens:** LinkedIn OAuth 2.0 does support refresh tokens, but the manual flow above generates short-lived tokens
3. **User Context:** The person URN (`urn:li:person:ID`) comes from the `sub` field in `/v2/userinfo`
4. **Legacy vs New API:** `/v2/me` is legacy, `/v2/userinfo` is the OpenID Connect standard

## For Production Use

Consider implementing a refresh token flow for long-term automation:
- Store the refresh token securely
- Exchange refresh token for new access token when expired
- Update the stored access token automatically

## Quick Reference

### Test Token Permissions:
```bash
curl https://api.linkedin.com/v2/userinfo \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get User URN:
```javascript
const userInfo = await axios.get('https://api.linkedin.com/v2/userinfo', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const urn = `urn:li:person:${userInfo.data.sub}`;
```

### Post Content:
```javascript
await axios.post('https://api.linkedin.com/v2/ugcPosts', postData, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Restli-Protocol-Version': '2.0.0'
  }
});
```