# /// script
# dependencies = [
#   "beautifulsoup4",
#   "pydantic_ai",
#   "pydantic_ai_harness",
#   "datetime",
#   "dataclasses",
#   "argparse",
# ]
# ///

import argparse
import json
import sys
#import logging
from pathlib import Path
#from bs4 import BeautifulSoup
from datetime import date
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai_harness import Shell #toSee
from seeds.tool_output import Fruit, Vehicle #huh?


model = OllamaModel(
    'gemma4', 
    provider=OllamaProvider(base_url='http://localhost:11434/v1'),
    settings={'max_tokens': 8192, 'temperature': 0.1, 'timeout': 3_000,'tool_choice':'auto'} #umm timeout and tool_choice ?
)

''' #oldie
agent = Agent(
  'ollama:gemma4',
  deps_type=str,  
  instructions="",  
)
'''

agent = Agent(model,deps_type=str,instructions="")
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
  ### RunUsage(input_tokens=49, output_tokens=91, requests=1
  return result.output

def ask_question(q, instructions) -> str:
  result = agent.run_sync(instructions, deps='Frank')  #q, instructions=instructions
  #HUH using the instructions as user_prompt only makes for better response!!
  # #all_messages() cant be json serialized so using all_messages_json()--toSee** if messages dont lose their type(prolly ok if == 'part_kind' ?)
  sys.stderr.write('\n[%s] %s :: \n %s ...\n' % ("Info:Ask", result.usage,result.all_messages_json().decode('utf-8'))) # str(content,'utf-8')
  return result.output

##to pass in system prompts and other stuff...prolly redundant?
def create_agent(sys_prompt,parent) -> Agent:
  return Agent(model,deps_type=str,system_prompt=sys_prompt)

def main():
  pass

if __name__ == '__main__':
  parser = argparse.ArgumentParser(
    description='Agent script to access local Ollama LLM')

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
  question = args.question #bork with acess 'q' ...toRemove?
  #test = get_output() #no logging :(
  #result = agent.run_sync('What is the date?', deps='Frank') # in past it was borkin cause it's synchronous! BUT works now!
  #another = get_daate() #this borked cause no await prolly?
  ### 'run_sync' is just a wrapper around 'run' and agents are always run in an async context.
  fromScript = args.fromP
  prompt = args.prompt

  sys.stderr.write('\n[%s] %s :>: %s ...Q: %s\r' % ("Ollama", "Starting from", fromScript, question)) 
  
  #result = get_date(question)
  result = ask_question(question,prompt)

  agenty = create_agent(prompt,fromScript) #toUse?
  d = {'daQ':question, 'output':result }
    
  #print(f' >> {question} >> {result.output}') #{test}
  #sys.stdout.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status"))
  #sys.stderr.write('[%s] %s%s ...%s\r' % ("bar", "percents", '%', "status")) ##yeee no error prefix!
  print(f'{return_json(d)}') ##need f to get actual string? >>nope
  #sys.stdout.flush()  #huh prolly sends everything in stdout AND print() out at same time!