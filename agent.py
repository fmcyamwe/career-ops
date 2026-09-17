# /// script
# dependencies = [
#   "beautifulsoup4",
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
from datetime import date
from typing import Any
from pydantic_ai import (
    Agent, 
    RunContext, 
    capture_run_messages, 
    ModelRetry, 
    ToolFailed,
    FinalResultEvent, 
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    PartStartEvent,
    RunContext,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPartDelta)
from pydantic_ai.toolsets import FunctionToolset
from pydantic_ai.capabilities import WebFetch, WebSearch, Capability, Thinking
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai_harness import Shell, FileSystem
from pydantic_ai_harness.subagents import SubAgent, SubAgents
#from pydantic_ai_harness.context import RepoContext
from seeds.tool_output import Fruit, Vehicle #huh?
import asyncio

''' bof
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler("app.log"),      # Writes to file
        logging.StreamHandler(sys.stdout)    # Writes to console
    ]
)
'''

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


model = OllamaModel(
    'gemma4', 
    provider=OllamaProvider(base_url='http://localhost:11434/v1'),
    settings={'temperature': 0.1,'top_k': 4, 'tool_choice': 'auto', 'thinking':'high'}
)# seed: int && thinking:`'minimal'`/`'low'`/`'medium'`/`'high'`/`'xhigh'`:...
#removed 'timeout': 3_000, 'max_tokens': 8192, >>tokens?, 'top_k':40, >>to consider possible next 40 choices? toTry when == 4

def write_to_file(indat, filename="output.txt"):
    with open(filename, "w") as file: #"example.txt"
        file.write(indat)

def read_from_file(filePath):
   with open(filePath, 'r', encoding='utf-8') as file:
    try:
        contents = file.read()
        return str(contents) #toSee #f"{contents}"
    except PermissionError:
        # Terminal — model should adapt, not retry the same call
        raise ToolFailed(f"Permission denied writing to {filePath}. Try a different path.")
    except OSError as e:
        # Transient — model should retry (e.g. file lock)
        raise ModelRetry(f"Transient error writing {filePath}: {e}. Retry in a moment.")

# 1. Define the custom toolset
custom_tools = FunctionToolset()

@custom_tools.tool
async def custom_write_file(ctx: RunContext[Any], path: str, content: str) -> str:
    """
    Custom write logic: e.g., validate content, use specific storage, 
    or trigger side effects before writing.
    """
    # Example: Custom validation or logic
    if not content.strip():
        return f"Error: Cannot write empty file to {path}"

    real_path = os.path.join(os.getcwd(),path)
    print(f'\ncustom_write_file:', path,real_path, content) #, os.path.dirname(__file__))
    if 'forbidden' in content.lower():
        raise ValueError("Content contains forbidden words")
    
    try:
        write_to_file(content,real_path)
        return f"Successfully wrote {len(content)} bytes to {real_path}"
    except PermissionError:
        # Terminal — model should adapt, not retry the same call
        raise ToolFailed(f"Permission denied writing to {real_path}. Try a different path.")
    except OSError as e:
        # Transient — model should retry (e.g. file lock)
        raise ModelRetry(f"Transient error writing {real_path}: {e}. Retry in a moment.")
    #return f"Successfully wrote {len(content)} bytes to {path}"

@custom_tools.tool
async def custom_read_file(ctx: RunContext[Any], fpath: str) -> str:
    # Custom validation or logging   #=Path(self.root_dir), 
    real_path = os.path.join(os.getcwd(),fpath)
    conte = read_from_file(real_path)
    print(f'\ncustom_read_file:\n',conte)
    #cont = await ctx.emit(CustomReadEvent(path=real_path, content=conte))
    #print(f'\ncustom_read_file:', fpath, Path.cwd(), real_path, conte, cont) #kLawGen/backend
    return conte #.content

refunds = Capability(
    id='refunds',
    description='Use for refund eligibility and refund status.',
    instructions='Always confirm the order ID before issuing a refund.',
)

@refunds.tool_plain
def refund_status(order_id: str) -> str:
    """Look up the refund status for an order."""
    print("refund_status OH")
    return f'Order {order_id}: refund issued on 2026-05-01.'

sysP = "Do NOT simulate the completion of the evaluation, Do your best to generate the entire markdown report based on all inputs then proceed directly to the file writing steps." # "Read the file tmpad1hni81.txt and write it's content to a new file new.txt"
#toadd? >> if not possible, you may do best with using placeholders for the generated content structure, as if the evaluation was completed successfully


reader = Agent(
  'ollama:gemma4', #need to have set 'OLLAMA_BASE_URL' env. var or borks
  name='reader', #'researcher', 
  description='Reads files and returns their content', #'Researches a topic and reports findings'
  #capabilities=[CustomFileSystem()] #workd..toSee with below
  toolsets=[custom_tools]
  )

writer = Agent(
  'ollama:gemma4',
  name='writer', 
  description='Writes given content to a file',#'Turns notes into polished prose'
  #capabilities=[CustomFileSystem()] #workd..toSee with below
  toolsets=[custom_tools]
  )

agent = Agent(
  model,
  deps_type=str,
  instructions="Incorporate all information from read files",
  retries={'tools': 3, 'output': 1},
  capabilities=[
    SubAgents(agents=[SubAgent(reader), SubAgent(writer)]),
    #FileSystem(root_dir='.'),
    #refunds
    WebSearch(local='duckduckgo'),
    WebFetch(local=True),
    Shell(cwd='.'),
    #RepoContext(
    #  workspace_dir=Path('.'), # nope for > home_dir=Path.home() >>so doesnt walk up to home_dir
    #  filenames=('AGENTS.md'), #'CLAUDE.md',
    #  asset_roots=('.agents')),  #wonder if will find SKILL.md in subfolder OR need to specify it in filenames parameter?
    Thinking(effort='high')
    ])

#dirr = Path(__file__).parent #ToSee if should use above...
#retries={'tools': 3, 'output': 1} to allow tool retry smh
##Shell(cwd='.', allowed_commands=['ls', 'node', 'cd']), ##huh with allowed_commands borks with ValueError::'Specify allowed_commands or denied_commands, not both.'
####weird...so default denied_commands but cant set allowed_commands too!?! weiiird!


#agenty =Agent() 
#could do empty agent and then redeclare it with sys prompts?..@annotations decorators below need instance smh
##THo...can forgo them and set in Agent arguments?(for Tools!)

'''
def get_output():
    html = '<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>'
    #logging.error(f"LLM completion failed: {html}", extra={"model": "gemma4"}) #nope 
    logging.debug(f"LLM response (attempt {1 + 1}): content[:300]") ##doesnt show--
    #logging.exception("LLM health check failed") #nope too
    return (BeautifulSoup(html, "html.parser").select_one("p.info").get_text()) #print
'''

def return_json(data) -> str:
  return json.dumps(data,indent=2) #umm indent?

#@agent.instructions  
def add_the_users_name(ctx: RunContext[str]) -> str:
  return f"The user's name is {ctx.deps}."

#@agent.instructions
def add_the_date() -> str:  
  return f'The date is {date.today()}.'

async def get_daate() -> str:
  result = await agent.run('What is the date?', deps='Frank')
  return result.output

def get_date(q) -> str: #synchronous
  result = agent.run_sync(q, deps='Frank')
  ##sys.stderr.write('\n[%s] %s%s ...%s\r' % ("date", "Frank", '%', result.usage)) 
  sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:date", result.usage, result.all_messages())) 
  ### RunUsage(input_tokens=49, output_tokens=91, requests=1)
  return result.output

def ask_question(q, instructions) -> str:
  result = agent.run_sync(instructions, deps='Frank')  #q, instructions=instructions
  #HUH using the instructions as user_prompt only makes for better response!!
  # #all_messages() cant be json serialized so using all_messages_json() > messages dont lose their type(prolly ok if == 'part_kind' ?)
  #sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:Ask", result.usage,result.all_messages_json().decode('utf-8') )) # str(content,'utf-8')
  sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:Asky", result.usage,result.all_messages() )) 
  return result.output

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

#####WebSearch(local=my_search)--toTry*** implement below
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
      print(f'{return_json({'daQ':q, 'output':result.output})}')
    
async def with_iter(q, instructions,useQ):
  sys.stdout.write(f'{return_json({'useQ':useQ, 'prompt':q, 'ollama_at':ollama_base_url, 'instru': instructions})}') 
  #weirdly print at end? 
  # deps='Frank',
  nodes = []
  output_messages: list[str] = []
  async with agent.iter(q if useQ else instructions,instructions=instructions if useQ else sysP, retries=3) as agent_run: # to see with sysP instead of None
    async for node in agent_run:
      #sys.stderr.write(f'{return_json({'Action':repr(node)})}')
      if Agent.is_user_prompt_node(node):
        output_messages.append(f'=== UserPromptNode: {node.user_prompt} ===')
        print(f'{return_json({'NodeType':'UserPromptNode','data': f'{node.user_prompt}' })}', flush=True) #>>oldie >> sys.stdout.write
      elif Agent.is_model_request_node(node):
        output_messages.append('=== ModelRequestNode: streaming partial request tokens ===')
        print(f'{return_json({'NodeType':'ModelRequestNode','data': 'streaming partial request tokens'})}', flush=True)
        async with node.stream(agent_run.ctx) as request_stream:
          final_result_found = False
          async for event in request_stream:
            if isinstance(event, PartStartEvent):
              output_messages.append(f'[Request] Starting part {event.index}: {event.part!r}')
              print(f'{return_json({'NodeType':'PartStartEvent','data': f'({event.index}: {event.part!r})' })}', flush=True)
            elif isinstance(event, PartDeltaEvent):
              if isinstance(event.delta, TextPartDelta):
                  output_messages.append(
                      f'[Request] Part {event.index} text delta: {event.delta.content_delta!r}'
                  )
              elif isinstance(event.delta, ThinkingPartDelta):
                  output_messages.append(
                      f'[Request] Part {event.index} thinking delta: {event.delta.content_delta!r}'
                  )
              elif isinstance(event.delta, ToolCallPartDelta):
                  output_messages.append(
                      f'[Request] Part {event.index} args delta: {event.delta.args_delta}'
                  )
            elif isinstance(event, FinalResultEvent):
              output_messages.append(
                f'[Result] The model started producing a final result (tool_name={event.tool_name})'
              )
              print(f'{return_json({'NodeType':'FinalResultEvent','data': f'({event.tool_name})' })}', flush=True)
              #sys.stdout.flush()
              final_result_found = True
              break
          if final_result_found:
            # Once the final result is found, we can call `AgentStream.stream_text()` to stream the text.
            # A similar `AgentStream.stream_output()` method is available to stream structured output.
            async for output in request_stream.stream_text():
              output_messages.append(f'[Output] {output}')
      elif Agent.is_call_tools_node(node):
        output_messages.append('=== CallToolsNode: streaming partial response & tool usage ===')
        print(f'{return_json({'NodeType':'CallToolsNode','output': "streaming partial response & tool usage"})}', flush=True)
        async with node.stream(agent_run.ctx) as handle_stream:
          async for event in handle_stream:
            if isinstance(event, FunctionToolCallEvent):
                output_messages.append(
                    f'[Tools] The LLM calls tool={event.part.tool_name!r} with args={event.part.args} (tool_call_id={event.part.tool_call_id!r})'
                )
                print(f'{return_json({'NodeType':'FunctionToolCallEvent','data': f'({event.part.args}: {event.part.tool_call_id!r})' })}', flush=True)
            elif isinstance(event, FunctionToolResultEvent):
                output_messages.append(
                    f'[Tools] Tool call {event.tool_call_id!r} :: {event.part.tool_name!r}  returned => {event.part.content}'
                )
                print(f'{return_json({'NodeType':'FunctionToolResultEvent','data': f'({event.tool_call_id}::{event.part.tool_name!r} => \n {event.part.content!r})' })}', flush=True)
      elif Agent.is_end_node(node):
        assert agent_run.result is not None
        assert agent_run.result.output == node.data.output
        output_messages.append(f'=== Final Agent Output: {agent_run.result.output} ===')
        print(f'{return_json({'NodeType':'FinalEndNode','data': f'{node.data.output}' })}', flush=True)

      nodes.append(node)
      sys.stderr.write(f'{return_json({'Action':repr(node)})}')
   
  usage = agent_run.result.usage
  tokens = {'input_tokens':usage.input_tokens, 'output_tokens':usage.output_tokens, 'requests': usage.requests ,'tool_calls': usage.tool_calls}
  #print(output_messages,sep="\n") # '\nweeee\n', tokens, agent_run.result.output )
  sys.stderr.write(f'{return_json(tokens)}')
  #sys.stderr.write('\n[%s] %s :: ...\n %s \n' % ("Info:Iter",agent_run.result.all_messages(), repr(nodes))) #repr(usage), repr(agent_run.usage or "None")
  #sys.stderr.flush()
  return agent_run.result.output

##to pass in system prompts and other stuff...prolly redundant?
def create_agent(sys_prompt,parent) -> Agent:
  return Agent(model,deps_type=str,system_prompt=sys_prompt)

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

  #sys.stderr.flush() #flush first?
  #logging.warning("This goes to both file and console....still? \n")
  #sys.stderr.write('\n\n[%s] %s :>: %s ...Q: %s\r' % ("Ollama", "Starting from", fromScript, question)) 
  
  try:
    result = await with_iter(question, prompt, True if fromScript == 'api-assistant' else False) #ask_question(question,prompt) if fromScript == 'api-assistant' else delegate_question(prompt, fromScript)
    #agenty = create_agent(prompt,fromScript) #toUse? toTest**
    d = {'daQ':question, 'output':result }
    print(f'{return_json(d)}')
    #parts = model.last_model_request_parameters.instruction_parts or []
    #print([(part.name, str(part.id) if part.id is not None else None, part.content) for part in parts])

  except Exception as e:
    #sys.stderr.write('\n\n\n[%s] %s :: \n %s ...\n' % ("Info:Tools", 'What tools are available?',result.output))
    print('An error occurred::with_iter >>' ,repr(e.__cause__),repr(e.__class__))
    with_capture(prompt)
    #hopefully above would still run?
    
  #print(f' >> {question} >> {result.output}') #{test}
  #sys.stdout.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status"))
  #sys.stderr.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status")) ##yeee no error prefix!
  #print(f'{return_json(d)}') ##need f to get actual string? >>nope
  #sys.stdout.flush()  #huh prolly sends everything in stdout AND print() out at same time!

if __name__ == '__main__':
  #main()
  asyncio.run(main())