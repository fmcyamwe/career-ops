# /// script
# dependencies = [
#   "beautifulsoup4",
# ]
# ///

##above helps not having python env...

from bs4 import BeautifulSoup

def get_output():
    html = '<html><body><h1>Welcome</h1><p class="info">This is a test.</p></body></html>'
    print(BeautifulSoup(html, "html.parser").select_one("p.info").get_text())

if __name__ == '__main__':
    get_output()