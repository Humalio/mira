// Setup guide: copy buttons for the code blocks. They are hidden in the page and shown
// from here, so without this script nobody is offered a button that does nothing.
// Screen readers hear the result through a status message, as the button text alone
// may change unannounced.
const announcer = document.createElement('p');
announcer.className = 'visually-hidden';
announcer.setAttribute('role', 'status');
announcer.setAttribute('aria-live', 'polite');
document.body.append(announcer);

for (const button of document.querySelectorAll('.copy[data-copy]')) {
	button.hidden = false;
	button.addEventListener('click', async () => {
		const text = document.getElementById(button.dataset.copy)?.textContent ?? '';
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = 'Copied';
			announcer.textContent = 'Copied to the clipboard';
		} catch {
			// no clipboard access (old browser or insecure page): open and select the text instead
			const code = document.getElementById(button.dataset.copy);
			code?.closest('details')?.setAttribute('open', '');
			const range = document.createRange();
			range.selectNodeContents(code);
			getSelection().removeAllRanges();
			getSelection().addRange(range);
			button.textContent = 'Selected';
			announcer.textContent = 'Text selected, ready to copy';
		}
		setTimeout(() => {
			button.textContent = 'Copy';
			// emptied, so the same message is announced again after the next click
			announcer.textContent = '';
		}, 1800);
	});
}
