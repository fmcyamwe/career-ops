# /// script
# dependencies = [
#   "pydantic",
#   "pydantic_ai",
# ]
# ///


from typing import Any
from pydantic_ai import RunContext, ModelRetry, ToolFailed 
#from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.toolsets import FunctionToolset
import os

def write_to_file(indat, filename="output.txt"):
  with open(filename, "w") as file: # encoding='utf-8' >> encoding makes diff? bon removed for now
    try:
      written = file.write(indat)
      return written
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error writing to {filename}: {e}. Retry in a moment.")

def read_from_file(filePath):
   with open(filePath, 'r', encoding='utf-8') as file:
    try:
      contents = file.read()
      return f"{contents}"
    except PermissionError:
      # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied writing to {filePath}. Try a different path.")
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error writing {filePath}: {e}. Retry in a moment.")


# 1. Define the custom toolset
custom_tools = FunctionToolset()

@custom_tools.tool_plain
def write_file(content: str, path: str ) -> str:
    """
    Custom write logic: e.g., validate content, use specific storage, 
    or trigger side effects before writing.
    """
    if not path.strip():
      toSend = {'OfType': 'Info','type':'Error--No path','from': 'custom_write_to_file', 'data':f' {path} >> {len(content)}'} 
      print(toSend,flush=True)
      ##umm try to string.replace here?
      return f"Error: No path to {path} >> {len(content)}"
        
    # Example: Custom validation or logic
    if not content.strip():
       return f"Error: Cannot write empty file to {path}"
    
    real_path = os.path.join(os.getcwd(),path)
    print(f'\ncustom_write_to_file: {path},{real_path} >> {len(content)} ',flush=True)
    try:
      succ = write_to_file(content,real_path)
      toSend = {'OfType': 'Info','type':'YEEE','from': 'custom_write_to_file', 'data': f'\n {succ} <> \n {path},{real_path} >> {len(content)}'} 
      print(toSend,flush=True)
      return f"Successfully wrote {len(content)} == {succ} characters to {real_path}"
    except PermissionError:
      # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied writing to {real_path}. Try a different path.")
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      toSend = {'OfType': 'Info','type':'Error--OSERR','from': 'custom_write_to_file', 'data':f' {path},{real_path} >> {len(content)}'} 
      print(toSend,flush=True)  ## f'\ncustom_write_to_file: ERROR YO OS-Retry \n path: {path},{real_path} >> {len(content)}'
      raise ModelRetry(f"Transient error writing {real_path}: {e}. Retry in a moment.")

@custom_tools.tool
async def read_file(ctx: RunContext[Any], fpath: str) -> str:
    # Custom validation or logging   #=Path(self.root_dir), 
    real_path = os.path.join(os.getcwd(),fpath)
    conte = read_from_file(real_path)
    print(f'\ncustom_read_file:',len(conte))
    #cont = await ctx.emit(CustomReadEvent(path=real_path, content=conte))
    #print(f'\ncustom_read_file:', fpath, Path.cwd(), real_path, conte, cont) #kLawGen/backend
    return conte #.content
