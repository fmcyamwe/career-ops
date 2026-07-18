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
import logging
from pathlib import Path
#from bs4 import BeautifulSoup
from datetime import date
from pydantic_ai import Agent, RunContext, capture_run_messages
from pydantic_ai.capabilities import WebFetch, WebSearch
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai_harness import Shell, FileSystem
from pydantic_ai_harness.subagents import SubAgent, SubAgents
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

model = OllamaModel(
    'gemma4', 
    provider=OllamaProvider(base_url='http://localhost:11434/v1'),
    settings={'max_tokens': 8192, 'temperature': 0.1, 'timeout': 3_000,'tool_choice':'auto'}
)

''' #oldie
agent = Agent(
  'ollama:gemma4',
  deps_type=str,  
  instructions="",  
)
'''

agent = Agent(
  model,
  deps_type=str,
  instructions="",
  retries={'tools': 3, 'output': 1},
  capabilities=[
    FileSystem(root_dir='.'),
    WebSearch(local='duckduckgo'),
    WebFetch(local=True),
    Shell(cwd='.')
    ])

#dirr = Path(__file__).parent #ToSee if should use above...
#retries={'tools': 3, 'output': 1} to allow tool retry smh
##Shell(cwd='.', allowed_commands=['ls', 'node', 'cd']), ##huh with allowed_commands borks with ValueError::'Specify allowed_commands or denied_commands, not both.'
####weird...so default denied_commands but cant set allowed_commands too!?! weiiird!

'''
fileReader = Agent(
  model,
  name='fileReader', 
  description='Read and return the content of a file'
)
'''

agenty =Agent() 
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
      print(return_json({'daQ':q, 'output':result.output}))
    
async def with_iter(q):
  nodes = []
  async with agent.iter(q,deps='Frank',retries=3) as agent_run:
    async for node in agent_run:
      nodes.append(node)
  #print(nodes)
  #print(agent_run.result.output)
  usage = agent_run.result.usage
  sys.stderr.write(return_json({'input_tokens':usage.input_tokens, 'output_tokens':usage.output_tokens, 'requests': usage.requests ,'tool_calls': usage.tool_calls}))
  sys.stderr.write('\n[%s] %s :: \n %s ...\n %s' % ("Info:Iter",repr(usage.details),agent_run.result.all_messages(), repr(nodes)))
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
    result = await with_iter(prompt) #ask_question(question,prompt) if fromScript == 'api-assistant' else delegate_question(prompt, fromScript)
    #agenty = create_agent(prompt,fromScript) #toUse? toTest**
    d = {'daQ':question, 'output':result }
    print(f'{return_json(d)}')
  except Exception as e:
    #sys.stderr.write('\n\n\n[%s] %s :: \n %s ...\n' % ("Info:Tools", 'What tools are available?',result.output))
    print('An error occurred::with_iter', repr(e.__cause__))
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