# Usage Examples

## Writing a Memory

```javascript
// Tool call: memory_write
{
  "title": "User prefers morning meetings",
  "content": "User mentioned they're most productive in the morning and prefer all meetings before noon.",
  "summary": "Prefers morning meetings, most productive AM",
  "layer": 1,
  "importance": 3,
  "tags": "preferences,schedule",
  "type": "user",
  "emotion_intensity": 0,
  "valence": 0.3,
  "action": "ADD"
}
```

## Searching Memories

```javascript
// Tool call: memory_search
{
  "query": "meeting preferences"
}
// Returns semantically similar memories ranked by relevance
```

## Surfacing Top Memories

```javascript
// Tool call: memory_surface
// No parameters — returns the most important active memories
// Sorted by: importance × recency × activation count
```

## Running Decay

```javascript
// Tool call: memory_decay
// Checks all active memories against decay thresholds
// Deactivates memories that haven't been recalled recently
// Pinned memories are exempt
```
