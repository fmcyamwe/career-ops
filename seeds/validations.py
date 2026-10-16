# /// script
# dependencies = [
#   "re"
# ]
# ///

import re

CLOSE_MARK = '<</cv-html>>'

def close_mark_present(content: str) -> bool:
  match = re.search(f'{CLOSE_MARK}', content) #r'\d+(\.\d{1,2})?'
  if match is not None:  #or can get AttributeError
    substring = match.group()
    return True if substring else False
  return False