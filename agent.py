# /// script
# dependencies = [
#   "beautifulsoup4",
#   "pydantic",
#   "pydantic_ai",
#   "pydantic-ai-slim[duckduckgo]",
#   "pydantic-ai-slim[web-fetch]",
#   "pydantic_ai_harness",
#   "datetime",
#   "dataclasses",
#   "argparse",
#   "asyncio",
# ]
# ///

import argparse
import json
import sys
import os
#import logging
from pathlib import Path
#from bs4 import BeautifulSoup
import random
from datetime import date
from typing import Any
from pydantic import BaseModel, Field
from pydantic_ai import (
    Agent, 
    RunContext,
    AgentStreamEvent,
    capture_run_messages, 
    ModelRetry, 
    ToolFailed)
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    RetryPromptPart,
    OutputToolCallEvent,
    OutputToolResultEvent,
    ThinkingPartDelta,
    TextPartDelta,
    ToolCallPartDelta,
    ThinkingPart,
    FinalResultEvent, 
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    PartEndEvent
)

from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai.capabilities import WebFetch, WebSearch, Capability, Thinking, LocalWorkspace
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai_harness import Shell, FileSystem
from pydantic_ai_harness.subagents import SubAgent, SubAgents
#from pydantic_ai_harness.context import RepoContext
from seeds.tool_output import Fruit, Vehicle, WriteFileArgss #toSee >> umm think borks script importing WriteFileArgs due to missing pydantic lib? or is it using? --guess ok when imported...
import asyncio


''' #oldie
agent = Agent(
  'ollama:gemma4',
  deps_type=str,  
  instructions="",  
)
'''

#env vars 
## to load from a .env file need
#  from dotenv import load_dotenv
## load_dotenv() >>then do below as normal...toTry**
ollama_base_url = os.getenv('OLLAMA_BASE_URL', 'localhost_test_test') 

class WriteFileArgs(BaseModel):
  content: str = Field(description="The file body content")
  path: str = Field(description="The target file path")

random.seed(None)
seed = random.randint(1, 100) #umm for model seed? toSee..

model = OllamaModel(
    'gemma4:e4b-mlx', #'gemma4', 
    provider=OllamaProvider(base_url='http://localhost:11434/v1'),
    settings={'temperature': 0.1, 'seed': seed, 'top_k':40, 'tool_choice': 'auto'}
)

subAgentModel = OllamaModel(
    'gemma4', 
    provider=OllamaProvider(base_url='http://localhost:11434/v1'),
    settings={'temperature': 0.1, 'seed': seed, 'top_k':40, 'tool_choice': 'auto'}
)
# seed: int 
# thinking:`'minimal'`/`'low'`/`'medium'`/`'high'`/`'xhigh'`. >> prolly no need as it's a thinking model...,'thinking':'high' >>toSee when reduced to minimal? smh slower? , 'thinking':'minimal'
#removed 'timeout': 3_000, 'max_tokens': 8192, 
# temperature good for Writing: 0.8-1.0 (toTry?**)  
## lower (0.0 to 0.2) to prioritize strict command logic over creative responses...umm?

# 'top_k':40, >>to consider possible next 40 choices?--default >> Limits the number of tokens AI picks at each step
### seem better when == 4 ? >>meh toSee with 64...umm nope >>removing it

#, "frequency_penalty":1.14 >>meh prolly bad...

# "top_p": 0.95 --toTry? >>Limits responses to the most probable tokens
### So 0.1 means only the tokens comprising the top 10% probability mass are considered.
###You should either alter `temperature` or `top_p`, but not both.

## also pass in "num_ctx": 32768, ? dont seem supported tho?.
###--oh it is but better to send it in parameter for each .run_sync() || .iter() request as below
# model_settings={
#        "extra_body": {
#            "num_ctx": 8192  # Set your desired context window here
#        }} ## 8192-16384 for long documents >>NOPE abruptly stop when set...
##umm could try and set different temperature, top_k || top_p per run as well? toTry**

reader = Agent(
  subAgentModel, #'ollama:gemma4',
  name='reader', #'researcher', 
  description='Reads files and returns their content', #'Researches a topic and reports findings'
  #capabilities=[CustomFileSystem()] #workd..below as well!
  #toolsets=[custom_tools]
  )

writer = Agent(
  subAgentModel, # 'ollama:gemma4',
  name='writer', 
  description='Writes given content to a file',#'Turns notes into polished prose'
  #capabilities=[CustomFileSystem()] #workd..below too!
 #toolsets=[custom_tools]
  ) 

def write_to_file(indat, filename="output.txt"):
  with open(filename, "w",encoding='utf-8') as file: # encoding='utf-8' >> encoding makes diff? bon removed for now
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
      return str(contents) #toSee #f"{contents}"
    except PermissionError:
        # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied reading from {filePath}. Try a different path.")
    except OSError as e:
        # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error reading from {filePath}: {e}. Retry in a moment.")

#retries={'tools': 3, 'output': 1} to allow tool retry smh
##Shell(cwd='.', allowed_commands=['ls', 'node', 'cd']), ##huh with allowed_commands borks with ValueError::'Specify allowed_commands or denied_commands, not both.'
####weird...so default denied_commands but cant set allowed_commands too!?! weiiird!


#agenty =Agent() 
#could do empty agent and then redeclare it with sys prompts?..@annotations decorators below need instance smh
##THo...can forgo them and set in Agent arguments?(for Tools!)



def validate_path(ctx: RunContext[Any], path: str, content: str) -> None:
  """Validate that a path is provided"""
  if not path.strip():
    raise ModelRetry(f'The field path is requiered')

def return_json(data) -> str:
  return json.dumps(data,indent=2) #umm indent?


#assistant agent --prolly no need for sys_prompt param? instructions prolly ok?
#umm should still pass in sys prompt with all those files context?
def create_assistant_agent() -> Agent:
  # 1. Define dependencies if needed (optional)
  # class MyDeps: ...
  
  # 2. Instantiate the agent
  #agent = Agent(
  #    model="openai:gpt-4o-mini",
  #    # deps_type=MyDeps, # if using dependencies
  #    system_prompt="You are a helpful assistant."
  #)
  assistant = Agent(
    model,
    #deps_type=str,
    instructions="Use the registered tool functions",
    retries={'tools': 3, 'output': 1},
    capabilities=[
      #SubAgents(include_self=True), #umm nah
      #SubAgents(agents=[SubAgent(reader), SubAgent(writer)]), ##huh > capabilities=[SubAgents(include_self=True)],
      #FileSystem(root_dir='.'),
      #refunds
      WebSearch(local='duckduckgo'),
      WebFetch(local=True),
      LocalWorkspace('.'),
      Shell(), #persist_cwd=True
      #RepoContext(
      #  workspace_dir=Path('.'), # nope for > home_dir=Path.home() >>so doesnt walk up to home_dir
      #  filenames=('AGENTS.md'), #'CLAUDE.md',
      #  asset_roots=('.agents')),  #wonder if will find SKILL.md in subfolder OR need to specify it in filenames parameter?
      #Thinking(effort='high')
      # cwd='.'
    ])

  # 3. Register tools using decorators
  @assistant.tool(name="write_file", description='Write argument contents to a file') #, retries=2
  async def write_file(ctx: RunContext[Any],args: WriteFileArgs ) -> str: #path: str, content: str
    if not args.content.strip():
      print(f'\nassistant_write_file:, {args.path} Error: no content? {args.content}',flush=True)
      return f"Error: Cannot write empty file to {args.path}"

    real_path = os.path.join(os.getcwd(),args.path)
    #print(f'\ncustom_write_file:, {args.path},{real_path}',flush=True) #, os.path.dirname(__file__))
    if 'forbidden' in args.content.lower():
      print(f'\nassistant_write_file:, {args.path} Error: forbidden in content? \n {args.content}',flush=True)
      raise ValueError("Content contains forbidden words") #handle here...todo**
    
    try:
      succ = write_to_file(args.content,real_path)
      print(f'\nassistant_write_file:,{succ} <> \n {args.path},{real_path} >> {len(args.content)}',flush=True)
      return f"Successfully wrote {len(args.content)} characters to {real_path}"
    except PermissionError:
      # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied writing to {real_path}. Try a different path.")
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error writing {real_path}: {e}. Retry in a moment.")


  @assistant.tool(name="read_file", description='Reads files and returns their content')
  async def read_file(ctx: RunContext[Any], fpath: str) -> str:
    # Custom validation or logging   #=Path(self.root_dir), 
    real_path = os.path.join(os.getcwd(),fpath)
    conte = read_from_file(real_path)
    #print(f'\ncustom_read_file:\n',conte)
    #cont = await ctx.emit(CustomReadEvent(path=real_path, content=conte))
    print(f'\nassistant_read_file:', fpath, Path.cwd(), real_path, conte, flush=True) #kLawGen/backend
    return conte #.content

  # 4. Return the configured agent
  return assistant

def create_run_agent(sys_prompt) -> Agent:
  # 1. Define dependencies if needed (optional)
  # class MyDeps: ...
  
  # 2. Instantiate the agent
  agent = Agent(
    model,
    #deps_type=str,
    system_prompt=sys_prompt,
    #instructions="Use the registered function tools. DO NOT run command",
    retries={'tools': 3, 'output': 1},
    capabilities=[
      #SubAgents(include_self=True, inherit_tools=True), #naah
      #SubAgents(agents=[SubAgent(reader), SubAgent(writer)]),
      SubAgents(agents=[SubAgent(reader), SubAgent(writer)], inherit_tools=True), #inherit_tools gon be deprecated tho...
      #FileSystem(root_dir='.'),
      #refunds
      WebSearch(local='duckduckgo'),
      WebFetch(local=True),
      LocalWorkspace('.'),
      Shell(), #persist_cwd=True
      #RepoContext(
      #  workspace_dir=Path('.'), # nope for > home_dir=Path.home() >>so doesnt walk up to home_dir
      #  filenames=('AGENTS.md'), #'CLAUDE.md',
      #  asset_roots=('.agents')),  #wonder if will find SKILL.md in subfolder OR need to specify it in filenames parameter?
      #Thinking(effort='high')
    ])

  @agent.tool_plain
  def write_file(content: str, path: str) -> str: #toSee if better than below 'write_file' smh without ctx --also try with WriteFileArgs still?
    real_path = os.path.join(os.getcwd(),path)
    print(f'\nagent_write_to_file: {path},{real_path} >> {len(content)} ',flush=True)
    try:
      succ = write_to_file(content,real_path)
      sys.stderr.write(f'\nagent_write_to_file:,{succ} <> \n {path},{real_path} >> {len(content)}')
      return f"Successfully wrote {len(content)} characters to {real_path}"
    except PermissionError:
      # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied writing to {real_path}. Try a different path.")
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error writing {real_path}: {e}. Retry in a moment.")

  @agent.tool #(name="read_file", description='Reads files and returns their content')
  async def read_file(ctx: RunContext[Any], fpath: str) -> str:
    # Custom validation or logging   #=Path(self.root_dir), 
    real_path = os.path.join(os.getcwd(),fpath)
    conte = read_from_file(real_path)
    #print(f'\ncustom_read_file:\n',conte)
    #cont = await ctx.emit(CustomReadEvent(path=real_path, content=conte))
    #sys.stderr.write(f'\nagent_read_file:, {fpath}, {Path.cwd()}, {real_path}') # \n\n {conte} 
    return conte

  @agent.tool #(name="append_to_file", description='Append given content to an existing file')
  def append_to_file(ctx: RunContext[Any], args: WriteFileArgs) -> str: #path: str, content_chunk: str
    """Append a chunk of text to a specific file path.""" 
    real_path = os.path.join(os.getcwd(),args.path)
    with open(real_path, "a") as file:
        file.write(args.content) #content_chunk
    return f"Successfully appended {len(args.content)} to {real_path}"

  @agent.tool_plain #(name="file_exists", description='Checks that a file exist at the given path')
  def file_exists(fpath: str) -> bool:  #ctx: RunContext[Any], 
    """Checks that a file exist at the given path.""" 
    real_path = os.path.join(os.getcwd(),fpath)
    if os.path.exists(real_path):
      sys.stderr.write(f'\n file_exists:, {fpath}, {real_path}, {os.path.isfile(real_path)}')
      return True

    sys.stderr.write(f'\n file_exists: NOPE :(, {fpath}, {real_path} ')
    return False

  ##tosee below >>meh...prolly no need as gets instructions anyway?
  # --umm should tho to keep model on track? --yuup toSee if invoked on all tool calls...
  # oldie >> but no need ...Use the registered read_file, write_file and append_to_file tool functions.
  @agent.instructions
  def instructions() -> str:  
    return f'Do not use nor invent placeholders to be added in reports. Always generate the content that needs persistence as instructed'
    
  
  #@agent.system_prompt  #toTry?
  def critical_rules() -> str:   
    return f'{sys_prompt}' #f'The date is {date.today()}.'

  # 4. Return the configured agent
  return agent

  '''
  # 3. Register tools using decorators
  # (args_validator=validate_path) >>seem to make it slower?
  @agent.tool #(name="write_file", description='Write argument contents to a file') #, retries=2
  async def write_file(ctx: RunContext[Any],args: WriteFileArgs ) -> str: #path: str, content: str
    try: 
      if not args.content.strip():
        sys.stderr.write(f'\nagent_write_file:, {args.path} Error: no content? {args.content}')
        return f"Error: Cannot write empty file to {args.path}"
    except AttributeError as e:
      raise ModelRetry(f"Transient agent_write_file error without proper attributes {args}: {e}. Retry with proper formatted arguments in a moment.")

    real_path = os.path.join(os.getcwd(),args.path)
    #print(f'\ncustom_write_file:, {args.path},{real_path}',flush=True) #, os.path.dirname(__file__))
    if 'forbidden' in args.content.lower():
      sys.stderr.write(f'\nagent_write_file:, {args.path} Error: forbidden in content? \n {args.content}')
      raise ValueError("Content contains forbidden words")  #handle here...todo**
    
    try:
      succ = write_to_file(args.content,real_path)
      sys.stderr.write(f'\nagent_write_file:,{succ} <> \n {args.path},{real_path} >> {len(args.content)}')
      return f"Successfully wrote {len(args.content)} characters to {real_path}"
    except PermissionError:
      # Terminal — model should adapt, not retry the same call
      raise ToolFailed(f"Permission denied writing to {real_path}. Try a different path.")
    except OSError as e:
      # Transient — model should retry (e.g. file lock)
      raise ModelRetry(f"Transient error writing {real_path}: {e}. Retry in a moment.")
  '''

'''
## for when need subagents? wonder if ok to declare them here?
##could filter more frmTask to allow more Tools?
def delegate_question(prompt, frmTask) -> str:
  #fileReader = Agent(
  #  model,
  #  name='fileReader', 
  #  description='Read and return the content of a file'
  #  )#think this subagent causes too many issues--borks for writing calls?!?
  result = agent.run_sync(prompt, deps='Frank', retries=3) #,capabilities=[SubAgents(agents=[SubAgent(fileReader)])] ) #, inherit_tools=True
  #logging.info(" Info:Delegate:: wonder where this one goes...\n") #not shown if not debug level
  sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:Delegate",result.usage ,result.all_messages()))
  #logging.warning('\n[%s] %s :: \n %s ...\n' % ("Delegate", frmTask, result.usage))
  return result.output

#####WebSearch(local=my_search)--toTry*** implement below?
def my_search(query: str) -> str:
  pass

def tools_question():
  result = agent.run_sync('What tools are available?')
  sys.stderr.write('\n\n\n[%s] %s :: \n %s ...\n' % ("Info:Tools", 'What tools are available?',result.output))
  #print([t.name for t in model.last_model_request_parameters.function_tools])

def with_capture(q):
  with capture_run_messages() as messages:
    try:
      result = agent.run_sync(q, deps='Frank')
    except Exception as e:
      print('An error occurred:', repr(e.__cause__))
      print('\n messages:', messages)
      #raise PDFRenderError(f"PDF rendering failed: {error_msg}") from e
    else:
      sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:Capture",result.usage ,messages))
      print(f'{return_json({'OfType': 'Result','daQ':q, 'output':result.output})}', flush=True)

def create_agent(sys_prompt,parent) -> Agent:
  return Agent(model,deps_type=str,system_prompt=sys_prompt)

'''

nodes = []
def record_event(event: AgentStreamEvent, daType:str) -> None:
  try:
    if isinstance(event, FinalResultEvent):
      toSend = {'OfType': 'NodeType','type':'FinalResultEvent','data':f'({event.tool_name})' }
      sys.stderr.write(f'{return_json(toSend)}')
      return #just to not go below....
    
    if isinstance(event, PartStartEvent):
      nodes.append(f'[Request] Starting part {event.index}: {event!r} \n')
      if isinstance(event.part, ToolCallPart): #ToolSearchCallPart | LoadCapabilityCallPart | ToolCallPart
        nodes.append(f'===[ToolCallPart] Tool {event.part.args}: {event.part.tool_name!r}==== previous >> {event.previous_part_kind}')
        sys.stderr.write(f'{return_json({'OfType': 'NodeType','type':'ToolCallPart','from': daType, 'data': f'{event.part.tool_name}', 'fromPrevious': f'{event.previous_part_kind}' })}') #, flush=True)
    elif isinstance(event, PartDeltaEvent): #TextPartDelta | ThinkingPartDelta | ToolCallPartDelta | SpeechPartDelta
      if isinstance(event.delta, TextPartDelta): 
        nodes.append(
          f'[TextPartDelta] Part {event.index} text delta: {event.delta.content_delta!r}'
        )
      elif isinstance(event.delta, ToolCallPartDelta):
        nodes.append(
          f'[ToolCallPartDelta] Part {event.index} args delta: {event.delta.args_delta!r}'
        )
      #elif isinstance(event.delta, ThinkingPartDelta): #too much
      #  nodes.append(
      #    f'[ThinkingPartDelta] Part {event.index} thinking delta: {event.delta.content_delta!r}'
      #  )
    #elif isinstance(event, ToolReturnPart): #prolly cant happen? nope
    #  nodes.append(f'[WOAH] ToolReturnPart? {event.tool_name} :: {event.part.part_kind} >> {event.part.args!r}')
    elif isinstance(event.part, ToolReturnPart): 
      nodes.append(
        f'[ToolReturnPart] From {event.part.tool_name} with contents? => {event.part.has_content()}'
      )
      toSend = {'OfType': 'NodeType','type':'ToolReturnPart','from': daType, 'data':f'{event.part.tool_name} with  contents? => {event.part.has_content()}' }
      sys.stderr.write(f'{return_json(toSend)}') #, flush=True)
    elif isinstance(event,PartEndEvent): # ModelResponsePart = TextPart | ToolSearchCallPart | LoadCapabilityCallPart | ToolCallPart | NativeToolSearchCallPart | NativeToolCallPart | NativeToolSearchReturnPart | NativeToolReturnPart | ThinkingPart | CompactionPart | FilePart | SpeechPart
      nodes.append(f'[WOAH] PartEndEvent? {event!r}')
      toSend = {'OfType': 'NodeType','type':'PartEndEvent','from?': daType, 'data':f'{event!r}', 'extra': f'{event.part.part_kind} >> {event.next_part_kind if event.next_part_kind is not None else '' }'}
      sys.stderr.write(f'{return_json(toSend)}')
      if isinstance(event.part, ThinkingPart): 
        nodes.append(f'[ThinkingPart] >> \n {event.part.content!r}')
        toSend = {'OfType': 'NodeType','type':'ThinkingPart','from?': daType, 'data':f'{event!r}' }
        sys.stderr.write(f'{return_json(toSend)}')
    elif isinstance(event.part, ThinkingPart): #?!? happens at end of all the multiple ThinkingPartDelta
      nodes.append(f'[ThinkingPart] >> \n {event.part.content!r}')
      toSend = {'OfType': 'NodeType','type':'ThinkingPart','from': daType, 'data':f'{event!r}' }
      sys.stderr.write(f'{return_json(toSend)}')

    elif isinstance(event,FunctionToolCallEvent):
      nodes.append(
        f'[FunctionToolCallEvent] Part  Args => {event!r}'
      )
      toSend = {'OfType': 'NodeType','type':'FunctionToolCallEvent','from': daType, 'data':f'{event!r}' }
      #sys.stderr.write(f'{return_json({'OfType': 'NodeType','type':'FunctionToolCallEvent','from': daType, 'data': f'{event.part.tool_name} with Args => {event.part.args!r} ' })}') #, flush=True)
      sys.stderr.write(f'{return_json(toSend)}')

    elif isinstance(event,FunctionToolResultEvent):#ToolReturnPart | RetryPromptPart
      nodes.append(
        f'[FunctionToolResultEvent] Part {event.part.tool_name} with contents: \n {event.part.content!r}'
      )
      sys.stderr.write(f'{return_json({'OfType': 'NodeType', 'from': daType, 'type':'FunctionToolResultEvent', 'on': f'{event.part.timestamp!r}' ,'data': f'{event.part.tool_name!r} => {event.part.outcome!r}' })}') #, flush=True) #{event.part.content!r}
      if isinstance(event.part, ToolReturnPart):
        nodes.append(
          f'====[ToolReturnPart] Part >> {event.part!r}'
        )
        toSend = {'OfType': 'NodeType','type':'ToolReturnPart','from': daType, 'data':f'{event.part!r}' }
        sys.stderr.write(f'{return_json(toSend)}')
      if isinstance(event.part,RetryPromptPart):
        nodes.append(
          f'====[RetryPromptPart] Part >> {event.part!r}'
        )
        toSend = {'OfType': 'NodeType','type':'RetryPromptPart','from': daType, 'data':f'{event.part!r}' }
        sys.stderr.write(f'{return_json(toSend)}')
    elif isinstance(event,OutputToolCallEvent):
      nodes.append(
        f'[OutputToolCallEvent] Part {event.part.tool_name} with args: \n {event.part.args!r}'
      )
      toSend = {'OfType': 'NodeType','type':'OutputToolCallEvent','from': daType, 'data':f'{event.part!r}' }
      sys.stderr.write(f'{return_json(toSend)}')
    elif isinstance(event,OutputToolResultEvent):#event.part >>  ToolReturnPart | RetryPromptPart
      nodes.append(
        f'[OutputToolResultEvent] Part {event.part.tool_name} with contents: \n {event.part.content!r}'
      )
    return
  except Exception as e:
    # Handles other unexpected errors like AttributeError access smh
    toSend = {'OfType': 'Info', 'mess': 'Exception issue in record_event', 'args':repr(e.args),'class': repr(e.__class__), 'forEvent': f'{event!r}' }
    print(return_json(toSend), flush=True) #f"record_event >> An error occurred: {e}")
    return


async def with_iter(agent, q, instructions, use_question):
  """
  Pass in question prompt for LLM to iter over agent graph's nodes as they are executed.
  Args:
    q: user prompt
    instructions: instructions
    use_question: whether to use the question or the instructions for the user prompt
    sys_prompt : when user_prompt consumes instructions, the instructions consumes any system prompt 
  Returns:
    Agent output results
  """
  sys.stdout.write(return_json({'OfType': 'Info', 'Seed': seed, 'usedQuestion?':use_question, 'prompt':q, 'ollama_at':ollama_base_url,'instru': instructions }))  # 'hasSysPrompt': sys_prompt is not None
  sys.stdout.flush()
  #weirdly print at end? >>cause was buffered so need to add flag 'flush=True' or flush as above smh
  # deps='Frank',
  #nodes: list[str] = [] #was output_messages..was giving probs?

  async with agent.iter(user_prompt=q if use_question else instructions,
                        instructions=instructions if use_question else None, 
                        retries=3) as agent_run:
    async for node in agent_run:
      #sys.stderr.write(f'{return_json({'Action':repr(node)})}')
      daType = ''
      if Agent.is_user_prompt_node(node):
        daType = 'UserPromptNode'
        nodes.append(f'=== UserPromptNode ===') #{node.user_prompt}
        toSend = {'OfType': 'NodeType','type': daType, 'data': f' No user_prompt?:{node.user_prompt is None} <> No instructions?: {node.instructions is None}' }
        sys.stderr.write(f'{return_json(toSend)}')# , flush=True) #>>oldie >> sys.stdout.write
      elif Agent.is_model_request_node(node):
        daType = 'ModelRequestNode'
        nodes.append('=== ModelRequestNode: streaming partial request tokens ===')
        #print(f'{return_json({'OfType': 'NodeType','type':'ModelRequestNode','data': 'streaming partial request tokens'})}', flush=True)
        async with node.stream(agent_run.ctx) as request_stream:
          final_result_found = False
          async for event in request_stream:
            #record_event(event, daType) #here? umm nah?
            if isinstance(event, FinalResultEvent):
              nodes.append(
                f'[Result] The model started producing a final result (tool_name={event.tool_name})'
              )
              toSend = {'OfType': 'NodeType','type':'FinalResultEvent','data':f'({event.tool_name})' }
              sys.stderr.write(f'{return_json(toSend)}') #, flush=True)
              final_result_found = True
              break
            #continue with streaming
            record_event(event, daType)

          if final_result_found:
            # Once the final result is found, we can call `AgentStream.stream_text()` to stream the text.
            # A similar `AgentStream.stream_output()` method is available to stream structured output.
            #delta=True to not do any validation..
            async for output in request_stream.stream_text(delta=True): 
              nodes.append(f'[Output] >> ModelRequestNode >> {output}') ##too noisy
              ##could check whole request_stream that not failed?...todo**
              #continue
              #sys.stderr.write(f'[Output] >> ModelRequestNode >> {output}') #toSee
      elif Agent.is_call_tools_node(node):
        daType = 'CallToolsNode'
        nodes.append(f'\n === CallToolsNode: streaming partial response & tool usage ===')
        sys.stderr.write(f'{return_json({'OfType': 'NodeType','type':daType,'data': "streaming partial response & tool usage"})}') #, flush=True)
        async with node.stream(agent_run.ctx) as handle_stream:
          async for event in handle_stream:
            record_event(event, daType)
      elif Agent.is_end_node(node):
        daType = 'EndNode'
        try: #just to catch abrupt end?
          assert agent_run.result is not None, "Result None?!?"
          assert agent_run.result.output == node.data.output , "Result Not same?!?"
        except AssertionError as e:
          sys.stderr.write(f'{return_json({'OfType': 'Info','type':daType,'data': f"\nERROR AssertionError >> {e!r} "})}')
        nodes.append(f'=== Final Agent Output: {agent_run.result.output} ===') #output_messages
        sys.stderr.write(f'{return_json({'OfType': 'NodeType','type':'FinalEndNode','from': daType, 'data': f'{node.data.output}' })}') #, flush=True)

      #nodes.append(node)
      sys.stderr.write(f'{return_json({f'Action-{daType}':repr(node)})}')

  #RunUsage(input_tokens=49, output_tokens=91, requests=1)
  usage = agent_run.result.usage
  tokens = {'OfType': 'Tokens','input_tokens':usage.input_tokens, 'output_tokens':usage.output_tokens, 'requests': usage.requests ,'tool_calls': usage.tool_calls}
  print(f'{return_json(tokens)}', flush=True)

  #print(output_messages,sep="\n", flush=True)
  #sys.stderr.write(f'{return_json(tokens)}')
  #sys.stderr.write({return_json('\n'.join(str(p) for p in output_messages))}) #seems to make script bork? or was somthing else?
  
  #sys.stderr.write(f'{return_json(tokens)}') #better to use stdout...moved up
  #sys.stderr.write('\n[%s] %s :: ...\n %s \n' % ("Info:Iter",agent_run.result.all_messages(), repr(nodes))) #repr(usage), repr(agent_run.usage or "None")
  #sys.stderr.flush()
  return agent_run.result.output


async def main():
  parser = argparse.ArgumentParser(description='Agent script to access local Ollama LLM')

  parser.add_argument('--question',
                      metavar='q',
                      type=str,
                      help='user question for Ollama model',
                      required=True)
  parser.add_argument('--prompt', 
                      metavar='p', 
                      type=str,
                      help='instructions',
                      required=False)
  parser.add_argument('--sys_prompt',
                      type=str,
                      help='system prompt',
                      required=False)
  parser.add_argument('--allowedTools',
                      metavar='a', 
                      type=str,
                      help='Allowed Tools that Ollama model can invoke',
                      required=False)
  parser.add_argument('--disallowedTools',
                      metavar='d', 
                      type=str,
                      help='Disallowed Tools that cannot be used',
                      required=False)
  parser.add_argument('--fromP',
                      metavar='f',
                      type=str,
                      help='Calling parent script',
                      required=False)

  args = parser.parse_args()
  question = args.question #bork with access 'q'
  #test = get_output() #no logging :(
  #result = agent.run_sync('What is the date?', deps='Frank') # in past it was borkin cause it's synchronous! BUT works now!
  #another = get_daate() #this borked cause no await prolly?
  ### 'run_sync' is just a wrapper around 'run' and agents are always run in an async context.
  fromScript = args.fromP
  prompt = args.prompt
  sys_prompt = args.sys_prompt

  use_question = True if fromScript == 'api-assistant' else False

  my_agent = create_run_agent(sys_prompt) if fromScript == 'api-run' else create_assistant_agent()

  try:
    #ask_question(question,prompt) if fromScript == 'api-assistant' else delegate_question(prompt, fromScript)
    result = await with_iter(my_agent, q=question, instructions=prompt, use_question=use_question) #,sys_prompt=sys_prompt
    #agenty = create_agent(prompt,fromScript) #toUse? toTest**
    d = {'OfType': 'Result','daQ':question,'output':result, 'from':fromScript }
    print(f'{return_json(d)}', flush=True)
    #parts = model.last_model_request_parameters.instruction_parts or []
    #print([(part.name, str(part.id) if part.id is not None else None, part.content) for part in parts])
    #sys.stderr.write(f'\n\n {return_json({'NODES':repr(nodes)})}') #umm wont bork? >>ouf can make for a laaarge file

  except Exception as e:
    #sys.stderr.write('\n\n\n[%s] %s :: \n %s ...\n' % ("Info:Tools", 'What tools are available?',result.output))
    print('An error occurred::with_iter >>',repr(e.args),repr(e.__class__), f'{e.__traceback__!r}')
    #with_capture(prompt)
    #hopefully above would still run?
    
  #print(f' >> {question} >> {result.output}') #{test}
  #sys.stdout.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status"))
  #sys.stderr.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status")) ##yeee no error prefix!
  #print(f'{return_json(d)}') ##need f to get actual string? >>nope
  #sys.stdout.flush()  #huh prolly sends everything in stdout AND print() out at same time!

if __name__ == '__main__':
  #main()
  asyncio.run(main())